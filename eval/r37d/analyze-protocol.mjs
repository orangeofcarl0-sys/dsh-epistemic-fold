#!/usr/bin/env node
/**
 * R37-D WP2: protocol efficiency and action-budget forensics.
 *
 * Reads the 24 C2 reports and traces, accounts every stored model turn, and
 * writes three artifacts:
 *
 *   action-accounting.json        per-cell counters and per-turn records
 *   protocol-efficiency.json      no-valid-action classes and rates by arm
 *   b2-d1-action-forensics.json   the B2 and D1 failure modes, separately
 *
 * The trace text is capped at 1,000 characters. Counters are authoritative;
 * per-turn classifications are labelled `stored-prefix` when the cap applies.
 *
 * @module eval/r37d/analyze-protocol
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountTurn, summarizeCell } from './src/action-accounting.mjs'
import { operationalContract } from './src/operational-completion.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const R37C = process.env.R37C_WORKTREE ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37c-closure'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function countBy(list, selector) {
  const counts = {}
  for (const entry of list) {
    const key = selector(entry)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function sum(list, selector) {
  return list.reduce((total, entry) => total + (selector(entry) ?? 0), 0)
}

function casePath(caseId) {
  for (const candidate of [
    join(REPO, 'eval', 'r37', 'cases', caseId, 'case.json'),
    join(REPO, 'eval', 'r33', 'cases', caseId, 'case.json'),
    join(R37C, 'eval', 'r37c', 'cases', caseId, 'case.json'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const caseCache = new Map()
async function loadCase(caseId) {
  if (caseCache.has(caseId)) return caseCache.get(caseId)
  const path = casePath(caseId)
  const data = path === null ? null : await readJson(path)
  caseCache.set(caseId, data)
  return data
}

const results = await readJson(join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json'))
const cells = []

for (const entry of results.results) {
  if (entry.status !== 'executed' || !existsSync(entry.reportPath)) continue
  const report = await readJson(entry.reportPath)
  const row = report.rows?.[0]
  if (row === undefined) continue
  const detail = row.behaviourDetail ?? {}
  const harness = detail.harness ?? {}
  const base = join(
    dirname(entry.reportPath),
    entry.cell.caseId,
    entry.cell.arm,
    entry.cell.replicateId,
  )
  const tracePath = join(base, 'trace', 'record.json')
  const workspace = join(base, 'workspace')
  let trace = null
  try {
    trace = await readJson(tracePath)
  } catch {
    trace = null
  }
  const caseData = await loadCase(entry.cell.caseId)
  const contract = operationalContract(caseData ?? { id: entry.cell.caseId, requiresTests: true })
  const turns = (trace?.followTrace ?? []).map((turn, index) => accountTurn({
    turn,
    maxSteps: harness.maxSteps ?? 8,
    index,
  }))
  const verificationArtifact = existsSync(join(workspace, 'verification.json'))
  const summary = summarizeCell({
    cell: entry.cell,
    turns,
    detail,
    harness,
    verificationArtifact,
    requiresVerificationArtifact: contract.verificationArtifact !== null,
  })
  cells.push({
    ...summary,
    tracePresent: trace !== null,
    traceTurns: turns.length,
    reportPath: entry.reportPath,
    tracePath,
  })
}

function aggregate(list) {
  const modelCalls = sum(list, cell => cell.modelCalls)
  const noValidActionCalls = sum(list, cell => cell.noValidActionCalls)
  const validActions = sum(list, cell => cell.validActions)
  const rejectedActions = sum(list, cell => cell.rejectedActions)
  const turns = list.flatMap(cell => cell.turns)
  return {
    cells: list.length,
    modelCalls,
    completedSteps: sum(list, cell => cell.completedSteps),
    toolCalls: sum(list, cell => cell.toolCalls),
    validActions,
    rejectedActions,
    noValidActionCalls,
    testsExecuted: sum(list, cell => cell.testsExecuted),
    finishRequests: sum(list, cell => cell.finishRequests),
    stepLimitCells: list.filter(cell => cell.stepLimitTermination).length,
    noValidActionRate: modelCalls === 0 ? null : noValidActionCalls / modelCalls,
    rejectedActionRate: modelCalls === 0 ? null : rejectedActions / modelCalls,
    validActionYield: modelCalls === 0 ? null : validActions / modelCalls,
    noValidActionClasses: countBy(
      turns.filter(turn => turn.noValidAction),
      turn => turn.noValidActionClass ?? 'no-action-other',
    ),
    turnEvidence: countBy(turns, turn => turn.evidence),
  }
}

const byArmGuard = Object.fromEntries(
  ['B1', 'S'].flatMap(arm => ['G0', 'G1'].map(guard => {
    const selected = cells.filter(cell => cell.arm === arm && cell.guard === guard)
    return [`${arm}/${guard}`, aggregate(selected)]
  })),
)
const byCase = Object.fromEntries(
  ['B2', 'D1-v2'].map(caseId => [caseId, aggregate(cells.filter(cell => cell.caseId === caseId))]),
)
const byArm = Object.fromEntries(
  ['B1', 'S'].map(arm => [arm, aggregate(cells.filter(cell => cell.arm === arm))]),
)

const actionAccounting = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP2-action-accounting',
  source: {
    results: join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json'),
    parserSha256: await sha256(join(REPO, 'eval', 'r37c', 'src', 'dsml-codec.mjs')),
    accountingSha256: await sha256(join(REPO, 'eval', 'r37d', 'src', 'action-accounting.mjs')),
    liveSha256: await sha256(join(REPO, 'eval', 'r33', 'live.mjs')),
  },
  definitions: {
    modelCalls: 'provider responses; the denominator for no-valid-action rates',
    completedSteps: 'loop iterations; a finish accepted at step N means N + 1 model calls',
    toolCalls: 'non-finish actions actually dispatched',
    validActions: 'parsed actions that passed validation',
    rejectedActions: 'parsed actions the validator rejected',
    noValidActionCalls: 'responses that produced no executable action',
  },
  cells,
}

const protocolEfficiency = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP2-protocol-efficiency',
  overall: aggregate(cells),
  byArm,
  byArmGuard,
  byCase,
  multiActionSemantics: (() => {
    const multi = cells.flatMap(cell => cell.turns
      .filter(turn => turn.actions.length > 1)
      .map(turn => ({
        cellId: cell.cellId,
        step: turn.step,
        modelOrder: turn.actions.map(action => action.tool),
        runtimeOrder: [
          ...turn.actions.filter(action => action.tool !== 'finish').map(action => action.tool),
          ...(turn.finishRequested ? ['finish'] : []),
        ],
        finishPosition: turn.finishPosition,
        finishMovedToEnd: turn.finishRequested && turn.finishPosition !== turn.actions.length - 1,
      })))
    return {
      policy: 'non-finish actions execute in model order; one finish is evaluated after all non-finish actions',
      source: 'eval/r33/src/action-order.mjs',
      turnsWithMultipleActions: multi.length,
      finishMovedToEnd: multi.filter(turn => turn.finishMovedToEnd).length,
      examples: multi.filter(turn => turn.finishMovedToEnd).slice(0, 10),
    }
  })(),
  notes: [
    'A no-valid-action turn is a consumed model call, not necessarily a parser bug.',
    'truncated-output requires positive provider truncation (finishReason max-tokens/length).',
    'A stored prefix at the 1,000-character cap is labelled unavailable-evidence when no diagnostic explains it.',
  ],
}

const b2Cells = cells.filter(cell => cell.caseId === 'B2')
const d1Cells = cells.filter(cell => cell.caseId === 'D1-v2')
const forensics = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP2-b2-d1-action-forensics',
  B2: {
    summary: {
      cells: b2Cells.length,
      cellsWithoutTest: b2Cells.filter(cell => cell.testsExecuted === 0).length,
      cellsWithRepeatedReads: b2Cells.filter(cell => Object.keys(cell.repeatedReadPaths).length > 0).length,
      cellsWithLegalCodeNoTest: b2Cells.filter(cell => cell.legalCodeNoTest).length,
      cellsWithInvalidEnvelope: b2Cells.filter(cell =>
        (cell.noValidActionClasses['invalid-envelope'] ?? 0) > 0).length,
      cellsWithTruncatedOutput: b2Cells.filter(cell =>
        (cell.noValidActionClasses['truncated-output'] ?? 0) > 0).length,
      noValidActionClasses: countBy(
        b2Cells.flatMap(cell => cell.turns.filter(turn => turn.noValidAction)),
        turn => turn.noValidActionClass ?? 'no-action-other',
      ),
      byArm: Object.fromEntries(['B1', 'S'].map(arm => [
        arm,
        aggregate(b2Cells.filter(cell => cell.arm === arm)),
      ])),
    },
    cells: b2Cells.map(cell => ({
      cellId: cell.cellId,
      arm: cell.arm,
      guard: cell.guard,
      testsExecuted: cell.testsExecuted,
      modelCalls: cell.modelCalls,
      completedSteps: cell.completedSteps,
      firstWriteStep: cell.firstWriteStep,
      firstTestStep: cell.firstTestStep,
      modelCallsBeforeFirstTest: cell.modelCallsBeforeFirstTest,
      invalidCallsBeforeFirstTest: cell.invalidCallsBeforeFirstTest,
      remainingBudgetAtFirstTest: cell.remainingBudgetAtFirstTest,
      readPaths: cell.readPaths,
      repeatedReadPaths: cell.repeatedReadPaths,
      listDirTurns: cell.listDirTurns,
      writePaths: cell.writePaths,
      legalCodeNoTest: cell.legalCodeNoTest,
      noValidActionClasses: cell.noValidActionClasses,
      stepLimitTermination: cell.stepLimitTermination,
    })),
  },
  D1: {
    summary: {
      cells: d1Cells.length,
      cellsWithoutTest: d1Cells.filter(cell => cell.testsExecuted === 0).length,
      cellsWithArtifact: d1Cells.filter(cell => cell.verificationArtifactPresent).length,
      cellsWithArtifactMissing: d1Cells.filter(cell => !cell.verificationArtifactPresent).length,
      failurePhase: countBy(d1Cells, cell => cell.verificationFailurePhase ?? 'not-applicable'),
      byArm: Object.fromEntries(['B1', 'S'].map(arm => [
        arm,
        aggregate(d1Cells.filter(cell => cell.arm === arm)),
      ])),
    },
    cells: d1Cells.map(cell => ({
      cellId: cell.cellId,
      arm: cell.arm,
      guard: cell.guard,
      testsExecuted: cell.testsExecuted,
      testResultsReceived: cell.testResultsReceived,
      firstTestStep: cell.firstTestStep,
      verificationWriteMentions: cell.verificationWriteMentions,
      verificationWriteValid: cell.verificationWriteValid,
      verificationArtifactPresent: cell.verificationArtifactPresent,
      verificationFailurePhase: cell.verificationFailurePhase,
      stepLimitTermination: cell.stepLimitTermination,
      modelCalls: cell.modelCalls,
      completedSteps: cell.completedSteps,
      noValidActionClasses: cell.noValidActionClasses,
    })),
  },
  interpretation: {
    B2: 'the dominant failure is a malformed DSML envelope or a truncated response; the parser rejects it correctly, and the agent spends the remaining steps on reads instead of a test',
    D1: 'the missing verification artifact has two distinct causes: a rejected write request, or no write request at all before the step limit',
  },
}

const discrepancies = []
for (const cell of cells) {
  if (!cell.tracePresent) discrepancies.push({ cellId: cell.cellId, detail: 'trace missing' })
  if (cell.traceTurns !== cell.modelCalls) {
    discrepancies.push({
      cellId: cell.cellId,
      detail: `trace turns ${cell.traceTurns} != model calls ${cell.modelCalls}`,
    })
  }
  if (cell.turns.some(turn => turn.actions.length > 0 && turn.invalidActions.length > 0)) {
    // Mixed turns are legal; the runner executes the valid actions and rejects
    // the rest. Recorded, not treated as an error.
  }
}

await writeFile(join(OUT, 'action-accounting.json'), `${JSON.stringify(actionAccounting, null, 2)}\n`, 'utf8')
await writeFile(join(OUT, 'protocol-efficiency.json'), `${JSON.stringify(protocolEfficiency, null, 2)}\n`, 'utf8')
await writeFile(join(OUT, 'b2-d1-action-forensics.json'), `${JSON.stringify(forensics, null, 2)}\n`, 'utf8')

process.stdout.write(`R37-D action accounting: ${join(OUT, 'action-accounting.json')}\n`)
process.stdout.write(`R37-D protocol efficiency: ${join(OUT, 'protocol-efficiency.json')}\n`)
process.stdout.write(`R37-D B2/D1 forensics: ${join(OUT, 'b2-d1-action-forensics.json')}\n`)
process.stdout.write(`cells ${cells.length}; model calls ${protocolEfficiency.overall.modelCalls}; `
  + `no-valid ${protocolEfficiency.overall.noValidActionCalls} `
  + `(${(protocolEfficiency.overall.noValidActionRate * 100).toFixed(2)}%); `
  + `rejected actions ${protocolEfficiency.overall.rejectedActions}\n`)
process.stdout.write(`classes ${JSON.stringify(protocolEfficiency.overall.noValidActionClasses)}\n`)
process.stdout.write(`B2 no-test ${forensics.B2.summary.cellsWithoutTest}/${b2Cells.length}; `
  + `D1 artifact missing ${forensics.D1.summary.cellsWithArtifactMissing}/${d1Cells.length}; `
  + `phases ${JSON.stringify(forensics.D1.summary.failurePhase)}\n`)
process.stdout.write(`discrepancies ${discrepancies.length}\n`)
process.exit(discrepancies.length === 0 ? 0 : 1)
