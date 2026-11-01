/**
 * R33-B/C: run every frozen case through every arm on the REAL engine.
 *
 * The model is scripted in this suite. That is deliberate and labelled: the
 * scripted writer supplies a fixed, frozen proposal, and the scripted follow-up
 * agent turns ONLY the arm's visible context into one finite action. The suite
 * therefore measures the PIPELINE (validation, commit, state delivery, action
 * consequence), not model intelligence. The live tier is a separate opt-in
 * runner; no result here is reported as a model result.
 *
 * The fold is real: `compactRegion` runs Basic's transaction through the EF
 * engine, and the suite asserts start/summary/replacement exist. A case whose
 * fold did not happen is `no-fold`, never a semantic success.
 *
 * @module tests/r33-arms
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { visibleAnchors } from '../src/semantic/plan.ts'
import { FileSemanticJournal } from '../src/semantic/journal.ts'
import { validateSemanticCommit } from '../src/semantic/integrity.ts'
import { replayWithSemanticCommits } from '../src/semantic/replay.ts'
import { MODEL, SIGNAL, createHarness, foldAgent } from './harness.ts'
import type { Harness, Session as HarnessSession } from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'
import { loadDataset, verifyFrozen } from '../eval/r33/src/dataset.mjs'
import {
  fullHistory,
  goldEvidenceBlock,
  goldFactsBlock,
  literalSummary,
  scriptedDecision,
  withTask,
} from '../eval/r33/src/context.mjs'
import { applyAction, materialize, readVerification, runChecker } from '../eval/r33/src/workspace.mjs'
import {
  aggregateArm,
  behaviourMetrics,
  extractionMetrics,
  pairedBootstrap,
  pairwise,
} from '../eval/r33/src/grade.mjs'

type Arm = 'B0' | 'B1' | 'S' | 'O1' | 'O2' | 'OR' | 'F' | 'N' | 'FM'

const ARMS: readonly Arm[] = ['B0', 'B1', 'S', 'O1', 'O2', 'OR', 'F', 'N', 'FM']

function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

function writerReply(handoff: string, deltas: readonly unknown[]): string {
  return `<handoff>\n${handoff}\n</handoff>\n<deltas>\n${JSON.stringify({ deltas })}\n</deltas>`
}

/** Turn a frozen transcript into closed turns plus one open task turn. */
function sessionOf(caseData: any): HarnessSession {
  const session = Session.create(SessionId(`r33-${caseData.id}-${randomUUID()}`))
  let turn = 0
  let step = 0
  let open = false
  const openTurn = (): void => {
    turn += 1
    session.append('turn/start', { turn })
    open = true
    step = 0
  }
  const closeTurn = (): void => {
    if (!open) return
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    open = false
  }
  for (const entry of caseData.transcript) {
    if (entry.role === 'user') {
      closeTurn()
      openTurn()
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      continue
    }
    if (!open) openTurn()
    step += 1
    session.append('step/start', { turn, step })
    if (entry.role === 'assistant') {
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: entry.text }],
          source: { kind: 'model', provider: MODEL, model: MODEL },
        }),
      }, { surfaceOp: 'append' })
    } else {
      const callId = ToolCallId(`call-${turn}-${step}`)
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking the recorded state.' },
            { type: 'tool-call', id: callId, name: entry.name, arguments: '{}' },
          ],
          source: { kind: 'model', provider: MODEL, model: MODEL },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: entry.name, arguments: '{}' })
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: entry.text }],
          isError: entry.isError === true,
        }),
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn, step })
  }
  closeTurn()
  openTurn()
  return session as HarnessSession
}

/** The last checkpoint text visible on the surface, for any engine. */
function visibleCheckpoint(session: HarnessSession): string {
  const nodes = [...session.surface.nodes]
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const message = session.deriveEventMessage(session.eventAt(nodes[index]!)!)
    if (message === null || message.role !== 'user') continue
    if (!isCompactCheckpointSource(message.source)) continue
    return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  }
  return ''
}

/** The replacement event's seq and a validity check for the fold transaction. */
function foldEvidence(session: HarnessSession): {
  readonly valid: boolean
  readonly startSeq?: number
  readonly summarySeq?: number
  readonly replacementSeq?: number
  readonly endSeq?: number
  readonly reason?: string
} {
  const events = session.snapshotEvents()
  const start = [...events].reverse().find(event => event.type === 'compaction/start')
  const summary = [...events].reverse().find(event => event.type === 'compaction/summary')
  const end = [...events].reverse().find(event => event.type === 'compaction/end')
  const replacement = [...events].reverse().find(event => {
    if (event.type !== 'user/message') return false
    const message = session.deriveEventMessage(event)
    return message !== null && isCompactCheckpointSource(message.source)
  })
  if (start === undefined || summary === undefined || replacement === undefined) {
    return {
      valid: false,
      reason: `missing ${start === undefined ? 'start' : summary === undefined ? 'summary' : 'replacement'}`,
    }
  }
  return {
    valid: true,
    startSeq: Number(start.seq),
    summarySeq: Number(summary.seq),
    replacementSeq: Number(replacement.seq),
    ...(end === undefined ? {} : { endSeq: Number(end.seq) }),
  }
}

async function foldTranscript(h: Harness, session: HarnessSession, arm: Arm): Promise<void> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('case has no foldable span')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  if (arm !== 'B0') await h.engine.reconcileSemantics(session)
}

/** Append the follow-up task as the one open user request after the fold. */
function appendTask(session: HarnessSession, task: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function deltaOf(fact: any): Record<string, unknown> {
  const quotes: readonly string[] = fact.oracleEvidence ?? [fact.quote]
  return {
    kind: fact.kind,
    subjectKey: fact.subjectKey,
    statement: fact.statement,
    status: fact.kind === 'finding' ? 'observed' : 'claimed',
    evidence: quotes.map(quote => ({ quote })),
    ...(fact.scope === undefined ? {} : { scope: fact.scope }),
  }
}

/** The gold facts as proposals, with explicit supersession where the case says so. */
function oracleDeltas(caseData: any): readonly Record<string, unknown>[] {
  const current = caseData.gold.filter((fact: any) => fact.current)
  const superseded = caseData.gold.filter((fact: any) => !fact.current)
  const deltas: Record<string, unknown>[] = []
  for (const old of superseded) {
    const replacement = current.find((fact: any) => fact.supersedesFactId === old.factId)
    if (replacement === undefined) continue
    deltas.push(deltaOf(old))
    deltas.push({ ...deltaOf(replacement), supersedes: [old.subjectKey] })
  }
  for (const fact of current) {
    const already = deltas.some(delta => delta.statement === fact.statement)
    if (!already) deltas.push(deltaOf(fact))
  }
  return deltas
}

async function harnessFor(arm: Arm, caseData: any, root: string): Promise<Harness> {
  const baseline = literalSummary(caseData.transcript)
  // The fault arm starts from the SAME active state as S, then injects a false
  // fact into the visible context. Starting from the semantic checkpoint is
  // what makes the fault a delivery test rather than a baseline test.
  const active = arm === 'S' || arm === 'O1' || arm === 'FM'
  const reply = arm === 'S' || arm === 'FM'
    ? writerReply(caseData.writer.handoff, caseData.writer.deltas)
    : arm === 'O1'
      ? writerReply(caseData.writer.handoff, oracleDeltas(caseData))
      : baseline
  return await createHarness(
    { textFor: options => isWriterCall(options) ? reply : baseline },
    {
      ...(arm === 'B0' ? { engine: 'basic' as const } : {}),
      ...(arm === 'B0' ? {} : { projection: true }),
      efConfig: arm === 'B0'
        ? {}
        : {
          semanticContinuity: active ? 'active' : 'off',
          semanticMode: 'rationale',
          semanticWorkingSetTokens: 2048,
          semanticCheckpointTokens: 8192,
          bundleRoot: join(root, 'bundles'),
          semanticRoot: join(root, 'semantic'),
        },
    },
  )
}

/** Replay the journal the fold wrote, so current-state metrics inspect STATE. */
async function stateValues(root: string, session: HarnessSession): Promise<readonly string[]> {
  const journal = new FileSemanticJournal(join(root, 'semantic'))
  const read = await journal.list(session.id)
  const commits = []
  for (const packet of read.packets) {
    if (packet.mode !== 'active') continue
    const receipt = read.receipts.get(packet.packetId)
    const validation = validateSemanticCommit({
      session,
      packet,
      ...(receipt === undefined ? {} : { receipt }),
    })
    if (validation.status === 'valid') commits.push(validation.commit)
  }
  const replay = replayWithSemanticCommits(session, commits)
  return visibleAnchors(replay.state).map(anchor => String(anchor.value))
}

interface Row {
  readonly caseId: string
  readonly riskClass: string
  readonly arm: Arm
  readonly valid: boolean
  readonly reason?: string
  readonly fold: ReturnType<typeof foldEvidence>
  readonly checkpointChars: number
  readonly extraction: any
  readonly behaviour: any
  readonly cost: {
    readonly modelRequests: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly wallClockMs: number
  }
  readonly inspector: {
    readonly contextChars: number
    readonly decision: any
    readonly action: string
    readonly checkerStatus: string
  }
  readonly diagnostic: boolean
}

async function runArm(arm: Arm, caseData: any, caseRoot: string): Promise<Row> {
  const runRoot = join(caseRoot, `run-${arm}`)
  const workspaceRoot = join(caseRoot, `workspace-${arm}`)
  await materialize(caseData.workspace.files, workspaceRoot)
  const h = await harnessFor(arm, caseData, runRoot)
  const session = sessionOf(caseData)
  const started = Date.now()
  await foldTranscript(h, session, arm)
  appendTask(session, caseData.task)
  const fold = foldEvidence(session)
  const checkpoint = visibleCheckpoint(session)
  const packet = arm === 'B0' ? undefined : h.engine.lastSemanticPacket
  const accepted = packet === undefined ? undefined : packet.accepted
  const refused = packet === undefined ? undefined : packet.refused
  const writer = arm === 'S' || arm === 'O1' ? h.engine.semanticWriterObservation : undefined
  const anchors = await stateValues(runRoot, session)
  const extraction = extractionMetrics(caseData, { accepted, refused, writer, checkpoint, anchorValues: anchors })

  let context: string
  if (arm === 'N') context = caseData.task
  else if (arm === 'F') context = withTask(fullHistory(caseData.transcript), caseData.task)
  else if (arm === 'O2') context = withTask(goldFactsBlock(caseData.gold), caseData.task)
  else if (arm === 'OR') context = withTask(`${checkpoint}\n\n${goldEvidenceBlock(caseData.gold, caseData.transcript)}`, caseData.task)
  else if (arm === 'FM') {
    const injection = caseData.falseMemory
    if (injection === undefined) {
      return {
        caseId: caseData.id,
        riskClass: caseData.riskClass,
        arm,
        valid: false,
        reason: 'no false-memory injection defined for this case',
        fold,
        checkpointChars: checkpoint.length,
        extraction,
        behaviour: { taskSuccess: false },
        cost: { modelRequests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: Date.now() - started },
        inspector: { contextChars: 0, decision: null, action: 'none', checkerStatus: 'not-run' },
        diagnostic: true,
      }
    }
    context = withTask(
      `${checkpoint}\n\nACTION-CRITICAL FACTS (injected fault):\n- ${injection.statement}`,
      caseData.task,
    )
  } else context = withTask(checkpoint, caseData.task)

  const decision = arm === 'FM'
    ? scriptedDecision({
      ...caseData,
      decision: {
        probes: [
          {
            contextIncludes: caseData.falseMemory.contextIncludes,
            action: caseData.falseMemory.action,
          },
          ...caseData.decision.probes,
        ],
        default: caseData.decision.default,
      },
    }, context)
    : scriptedDecision(caseData, context)
  await applyAction(caseData.actions[decision.action], workspaceRoot)
  const verification = await readVerification(workspaceRoot)
  const checker = await runChecker(caseData, workspaceRoot)
  const behaviour = behaviourMetrics(caseData, {
    checker,
    decision,
    verification,
    testsExecuted: caseData.actions[decision.action]?.testsExecuted ?? 0,
  })
  const elapsed = Date.now() - started
  if (!fold.valid) {
    return {
      caseId: caseData.id,
      riskClass: caseData.riskClass,
      arm,
      valid: false,
      reason: `no-fold: ${fold.reason ?? 'unknown'}`,
      fold,
      checkpointChars: checkpoint.length,
      extraction,
      behaviour,
      cost: { modelRequests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: elapsed },
      inspector: { contextChars: context.length, decision, action: decision.action, checkerStatus: checker.status },
      diagnostic: arm === 'FM',
    }
  }
  return {
    caseId: caseData.id,
    riskClass: caseData.riskClass,
    arm,
    valid: true,
    fold,
    checkpointChars: checkpoint.length,
    extraction,
    behaviour,
    cost: { modelRequests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: elapsed },
    inspector: { contextChars: context.length, decision, action: decision.action, checkerStatus: checker.status },
    diagnostic: arm === 'FM',
  }
}

function markdown(report: any): string {
  const lines = [
    '# R33 offline arm report',
    '',
    `- dataset: \`${report.datasetDigest}\` (${report.caseCount} frozen cases)`,
    `- execution: \`${report.executionKind}\``,
    `- generated: ${report.generatedAt}`,
    '',
    'This is a scripted-writer / scripted-follow-up measurement of the PIPELINE. It is not a model result.',
    '',
    '## Per-arm aggregate',
    '',
    '| arm | valid | success | damage | task success | critical recall | grounded precision | false normative | current state | direct visibility |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  const fmt = (value: any): string => value === null || value === undefined ? 'n/a' : typeof value === 'number' ? value.toFixed(3) : String(value)
  for (const entry of report.arms) {
    lines.push(`| ${entry.arm} | ${entry.valid}/${entry.cases} | ${entry.success} | ${entry.damage} | ${fmt(entry.taskSuccessRate)} | ${fmt(entry.meanCriticalRecall)} | ${fmt(entry.meanGroundedPrecision)} | ${fmt(entry.meanFalseNormativeRate)} | ${fmt(entry.meanCurrentStateAccuracy)} | ${fmt(entry.meanDirectVisibility)} |`)
  }
  lines.push('', '## Task-level comparisons (left vs right)', '')
  lines.push('| left | right | pairs | left-only (damage) | right-only (rescue) | both | neither |')
  lines.push('|---|---|---:|---:|---:|---:|---:|')
  for (const comparison of report.comparisons) {
    lines.push(`| ${comparison.left} | ${comparison.right} | ${comparison.valid} | ${comparison.leftOnly} | ${comparison.rightOnly} | ${comparison.both} | ${comparison.neither} |`)
  }
  lines.push('', '## Per-case rows', '')
  lines.push('| case | arm | success | action | failed checks | critical recall | current state | checkpoint chars |')
  lines.push('|---|---|---:|---|---|---:|---:|---:|')
  for (const row of report.rows) {
    lines.push(`| ${row.caseId} | ${row.arm} | ${row.behaviour.taskSuccess ? 'yes' : 'no'} | ${row.inspector.action} | ${(row.behaviour.failedChecks ?? []).join(', ') || '-'} | ${fmt(row.extraction?.criticalRecall)} | ${fmt(row.extraction?.currentStateAccuracy)} | ${row.checkpointChars} |`)
  }
  return `${lines.join('\n')}\n`
}

describe('R33 frozen semantic-continuity arms', () => {
  it('runs every case through every applicable arm and writes a reproducible report', async () => {
    const frozen = await verifyFrozen()
    expect(frozen.ok, frozen.reason).toBe(true)
    const { cases, errors, datasetDigest } = await loadDataset()
    expect(errors).toEqual([])
    expect(cases.length).toBeGreaterThanOrEqual(6)

    const root = await makeTemp('ef-r33-arms-')
    const rows: Row[] = []
    for (const caseData of cases) {
      const caseRoot = join(root, caseData.id)
      await mkdir(caseRoot, { recursive: true })
      for (const arm of ARMS) {
        if (arm === 'FM' && caseData.falseMemory === undefined) continue
        rows.push(await runArm(arm, caseData, caseRoot))
      }
    }

    const applicableArms = ARMS.filter(arm =>
      arm !== 'FM' || rows.some(row => row.arm === 'FM'))
    const arms = applicableArms.map(arm => aggregateArm(arm, rows))
    const comparisons = [
      pairwise(rows, 'S', 'B1'),
      pairwise(rows, 'S', 'B0'),
      pairwise(rows, 'O1', 'S'),
      pairwise(rows, 'O2', 'O1'),
      pairwise(rows, 'F', 'S'),
      pairwise(rows, 'S', 'N'),
      pairwise(rows, 'O1', 'B1'),
      pairwise(rows, 'OR', 'B1'),
    ]
    const report = {
      schemaVersion: 1,
      status: 'executed-success',
      executionKind: 'scripted-writer + scripted-follow-up (pipeline measurement, not a model result)',
      datasetDigest,
      caseCount: cases.length,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        vitest: '5.0.5',
      },
      arms,
      comparisons,
      bootstrap: {
        'S-vs-B1': pairedBootstrap(rows, 'S', 'B1'),
        'O1-vs-S': pairedBootstrap(rows, 'O1', 'S'),
        'O2-vs-O1': pairedBootstrap(rows, 'O2', 'O1'),
      },
      diagnostic: {
        falseMemoryRows: rows.filter(row => row.arm === 'FM').length,
        falseMemoryDetected: rows.filter(row => row.arm === 'FM'
          && (row.behaviour.constraintViolation || row.behaviour.obsoleteRevival || row.behaviour.rejectedRetrial
            || row.behaviour.falseVerificationClaim)).length,
        noFoldRows: rows.filter(row => !row.valid).length,
      },
      rows,
    }

    const outDir = join(process.cwd(), 'eval', 'r33', 'out')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'offline-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await writeFile(join(outDir, 'offline-report.md'), markdown(report), 'utf8')
    // A sibling of the temp root, so the report is self-contained for review.
    await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    // Validity invariants: a fold happened for every non-FM row, and every
    // checker executed. A `no-fold` is a benchmark defect, not a result.
    const noFold = rows.filter(row => !row.valid && row.reason !== 'no false-memory injection defined for this case')
    expect(noFold, JSON.stringify(noFold.map(row => ({ case: row.caseId, arm: row.arm, reason: row.reason })))).toEqual([])
    const badChecker = rows.filter(row => row.valid && row.inspector.checkerStatus !== 'executed')
    expect(badChecker).toEqual([])
    // The fault arm must be DETECTED: the grader has to see wrong memory as a
    // violation, not just as a different successful action.
    expect(report.diagnostic.falseMemoryRows).toBeGreaterThan(0)
    expect(report.diagnostic.falseMemoryDetected).toBe(report.diagnostic.falseMemoryRows)
    // B0 and B1 must not silently become semantic arms.
    expect(arms.find(entry => entry.arm === 'B0').meanCriticalRecall).toBeNull()
    expect(arms.find(entry => entry.arm === 'B1').meanCriticalRecall).toBeNull()

    // ---- Instrument invariants for THIS frozen dataset ---------------------
    // These are not product claims; they are the properties that make the
    // report interpretable. If a case change breaks one, the instrument is
    // wrong until the change is explained.
    const caseIds = (arm: string, predicate: (row: Row) => boolean): string[] =>
      rows.filter(row => row.arm === arm && predicate(row)).map(row => row.caseId).sort()
    // The semantic pipeline carries every case except the two diagnosed bottlenecks.
    expect(caseIds('S', row => !row.behaviour.taskSuccess)).toEqual(['F4', 'H1'])
    // The oracle delta arm fixes the writer omission (H1) but cannot exceed the
    // per-fold delta limit (F4): that is the writer/coverage vs capacity split.
    expect(caseIds('O1', row => !row.behaviour.taskSuccess)).toEqual(['F4'])
    // Direct facts and full history succeed on both: the tasks and the follow-up
    // actions are solvable, so the S failures are not task difficulty.
    expect(caseIds('O2', row => !row.behaviour.taskSuccess)).toEqual([])
    expect(caseIds('F', row => !row.behaviour.taskSuccess)).toEqual([])
    // The null control fails the memory-dependent retrieval case and passes the
    // two history-independent controls.
    expect(caseIds('N', row => row.behaviour.taskSuccess)).toEqual(['F1', 'G1', 'G2'])
    // The baseline loses the two mechanisms, and S rescues them without damage.
    const sVsB1 = comparisons[0]!
    expect(sVsB1.leftOnly).toBeGreaterThan(0)
    expect(sVsB1.rightOnly).toBe(0)
    expect(arms.find(entry => entry.arm === 'S').success)
      .toBeGreaterThan(arms.find(entry => entry.arm === 'B1').success)
    // The new diagnostics are what make the two failures legible.
    const sF4 = rows.find(row => row.arm === 'S' && row.caseId === 'F4')!
    expect(sF4.extraction.writer.limitExceeded).toBe(1)
    expect(sF4.extraction.writer.detail).toContain('limit')
    const sF1 = rows.find(row => row.arm === 'S' && row.caseId === 'F1')!
    expect(sF1.extraction.writer.refusals['authority-ungrounded']).toBe(1)
    const sH1 = rows.find(row => row.arm === 'S' && row.caseId === 'H1')!
    expect(sH1.extraction.writer.proposed).toBe(0)
    expect(sH1.extraction.criticalRecall).toBe(0)
    const sG1 = rows.find(row => row.arm === 'S' && row.caseId === 'G1')!
    expect(sG1.extraction.writer.proposed).toBe(0)
    expect(sG1.extraction.writer.coverage).toBe('not-assessed')
    expect(sG1.extraction.applicable).toBe(false)
  }, 180_000)
})
