/**
 * R31-D3: 10 / 30 / 100 REAL folds, measured on the host token meter.
 *
 * This is not the pure working-set compiler simulation. Every iteration appends
 * a closed turn and runs a real Basic compaction through the production plugin;
 * every semantic packet is staged, committed, and replayed by the journal. The
 * measurements are `TokenMeasurement` values from the mounted meter, not
 * `chars/4`.
 *
 * @module tests/semantic-longrun-real
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { deriveCheckpointResidency, retireCheckpoint } from '../src/checkpoint/residency.ts'
import { parseCheckpointMarker } from '../src/checkpoint/checkpoint-marker.ts'
import {
  MODEL,
  SIGNAL,
  conversation,
  createHarness,
  foldAgent,
  idleAgent,
  type Harness,
  type Session,
} from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'

const PADDING = ` ${'padding '.repeat(400)}`.trimEnd()

function writerReply(handoff: string, deltas: readonly unknown[]): string {
  return [
    '<handoff>', handoff, '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

function isWriterCall(options: { readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[] }): boolean {
  const last = options.messages[options.messages.length - 1]
  return last?.content.some(block =>
    block.type === 'text' && block.text?.startsWith('You are the SEMANTIC WRITER')) === true
}

function appendClosedTurn(session: Session, turn: number, userText: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${userText} ${PADDING}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `Acknowledged ${turn}. ${PADDING}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turn + 1 })
}

async function foldOpen(h: Harness, session: Session): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle!.rendered.text
}

interface RunMeasurement {
  readonly folds: number
  readonly surfaceTokens: number
  readonly activeContextTokens: number
  readonly frozenCheckpointTokens: number
  readonly frozenCheckpoints: number
  readonly workingStateTokens: number
  readonly omittedSemanticItems: number
  readonly retiredCheckpoints: number
  readonly latestCorrect: boolean
  readonly firstValueVisible: boolean
  readonly rootApplied: boolean
  readonly afterRootTokens: number
  readonly afterExitTokens: number
  readonly recallFirst: boolean
  readonly recallRetired: boolean
}

async function run(folds: number): Promise<RunMeasurement> {
  const root = await makeTemp(`ef-r31-longrun-${folds}-`)
  const box = { text: writerReply('start', []) }
  const h = await createHarness(
    { textFor: options => isWriterCall(options) ? box.text : 'digest' },
    {
      plugin: true,
      tools: true,
      systemPrompt: true,
      efConfig: {
        auto: false,
        bundleRoot: join(root, 'bundles'),
        semanticRoot: join(root, 'semantic'),
        semanticContinuity: 'active',
        semanticMode: 'rationale',
        semanticWorkingSetTokens: 512,
      },
    },
  )
  const session = conversation(2)
  const checkpointIds: string[] = []
  let lastBody = ''

  for (let index = 1; index <= folds; index += 1) {
    if (index > 1) {
      appendClosedTurn(session, index + 1, `Phase ${index} timeout revision.`)
    }
    // One pinned constraint revised at the SAME coordinate every fold: the
    // checkpoint must show the newest value and never the old one.
    box.text = writerReply(`Phase ${index}.`, [{
      kind: 'constraint',
      subjectKey: 'timeout',
      statement: `The timeout revision is value-${index}.`,
      status: 'claimed',
      evidence: [{ quote: `Phase ${index}` }],
    }, {
      kind: 'decision',
      subjectKey: `phase-${index}`,
      statement: `Phase ${index} recorded decision-${index}.`,
      status: 'claimed',
      evidence: [{ quote: `Phase ${index}` }],
    }])
    lastBody = await foldOpen(h, session)
    checkpointIds.push(h.engine.publishedBundle!.checkpointId)
  }

  const measured = h.ctx.tokenMeter.measure(session)
  let frozenCheckpointTokens = 0
  let frozenCheckpoints = 0
  for (const node of measured.nodes) {
    const event = session.eventAt(node.seq)
    const message = event === undefined ? null : session.deriveEventMessage(event)
    const text = message === null
      ? ''
      : message.content.map(block => block.type === 'text' ? block.text : '').join('')
    if (parseCheckpointMarker(text) === undefined) continue
    frozenCheckpoints += 1
    frozenCheckpointTokens += node.tokens
  }
  const beforeRootNodes = session.surface.nodes.length

  // ---- Root rebase: a real whole-chain fold through compactNow.
  const openTurn = Math.max(...Array.from({ length: session.seq }, (_, seq) => {
    const event = session.eventAt(seq as never)
    return event?.type === 'turn/start' ? (event.data as { turn: number }).turn : 0
  }))
  session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
  await h.engine.compactNow(idleAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  session.append('turn/start', { turn: openTurn + 1 })
  const rootBody = h.engine.publishedBundle!.rendered.text
  const afterRoot = h.ctx.tokenMeter.measure(session)
  const rootApplied = h.engine.rootFoldCount === 1
    && session.surface.nodes.length < beforeRootNodes
    && rootBody.includes(`value-${folds}`)

  // ---- Phase Exit: retire the latest checkpoint and honour it on the surface.
  const latest = h.engine.publishedBundle!.checkpointId
  const site = deriveCheckpointResidency(session as never).sites
    .find(candidate => candidate.checkpointId === latest)
  if (site?.surfaceSeq !== undefined) {
    const outcome = retireCheckpoint(session as never, latest, 'long-horizon exit')
    expect(outcome.written).toBe(true)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `[earlier context retired; ref "cp:${latest}"]` }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: site.surfaceSeq, endSeq: site.surfaceSeq },
      sourceEventSeqs: [site.surfaceSeq],
    } as never)
  }
  const residencyAfter = deriveCheckpointResidency(session as never)
  const afterExit = h.ctx.tokenMeter.measure(session)

  const recall = async (checkpointId: string): Promise<string> => {
    const result = await h.ctx.tools.execute({
      callId: `call-${randomUUID()}` as never,
      name: 'context_recall',
      arguments: { ref: `cp:${checkpointId}`, depth: 'exact', offset: 0, limit: 10 },
      agent: foldAgent(session),
      signal: SIGNAL,
    })
    return result.isError
      ? ''
      : (result.content as readonly { type: string; text?: string }[])
          .map(block => block.text ?? '').join('\n')
  }
  const recallFirst = (await recall(checkpointIds[0]!)).includes('fixture user 1')
  // Exact recall returns a bounded page of the ARCHIVED checkpoint chain, not
  // the retired checkpoint's own body. The page must still resolve and carry
  // checkpoint content after the marker left the surface.
  const retiredRecallText = await recall(latest)
  const recallRetired = retiredRecallText.includes('[EF1') && retiredRecallText.length > 0

  const measurement: RunMeasurement = {
    folds,
    surfaceTokens: measured.surfaceTokens,
    activeContextTokens: measured.totalTokens,
    frozenCheckpointTokens,
    frozenCheckpoints,
    workingStateTokens: h.engine.lastWorkingSet?.tokens ?? 0,
    omittedSemanticItems: h.engine.lastWorkingSet?.archived ?? 0,
    retiredCheckpoints: residencyAfter.retired,
    latestCorrect: lastBody.includes(`value-${folds}`)
      && !lastBody.includes('value-1.'),
    firstValueVisible: lastBody.includes('value-1.'),
    rootApplied,
    afterRootTokens: afterRoot.totalTokens,
    afterExitTokens: afterExit.totalTokens,
    recallFirst,
    recallRetired,
  }
  console.log(`[r31-longrun] ${JSON.stringify(measurement)}`)
  return measurement
}

describe('R31-D3: long-horizon real folds', () => {
  it('10 / 30 / 100 folds keep the latest value and report a bounded body', async () => {
    const measurements: RunMeasurement[] = []
    for (const folds of [10, 30, 100]) {
      measurements.push(await run(folds))
    }
    for (const measurement of measurements) {
      // A checkpoint body is bounded by its working set; the FROZEN chain is
      // not, which is exactly why root/exit are measured separately.
      expect(measurement.workingStateTokens).toBeLessThan(2_000)
      expect(measurement.latestCorrect).toBe(true)
      // The first value was superseded at the same coordinate; it must not be
      // rendered again by any later fold.
      expect(measurement.firstValueVisible).toBe(false)
      expect(measurement.recallFirst).toBe(true)
      expect(measurement.rootApplied).toBe(true)
      expect(measurement.recallRetired).toBe(true)
      expect(measurement.retiredCheckpoints).toBeGreaterThanOrEqual(1)
      // Exit must reclaim surface tokens, and root must be no worse than the
      // accumulated chain it replaced.
      expect(measurement.afterExitTokens).toBeLessThanOrEqual(measurement.afterRootTokens)
    }
    const hundred = measurements.find(entry => entry.folds === 100)!
    expect(hundred.frozenCheckpoints).toBeGreaterThanOrEqual(30)
    // Working state is compiled, not accumulated: the omitted items are
    // counted and retrievable, while the FROZEN chain is the part root/exit
    // must reclaim.
    expect(hundred.omittedSemanticItems).toBeGreaterThan(0)
  }, 180_000)
})
