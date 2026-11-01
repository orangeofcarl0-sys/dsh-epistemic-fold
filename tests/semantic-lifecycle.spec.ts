/**
 * R31-D2: Leaf, Leaf, revision, Root, Leaf, Phase Exit, Recall, Restart, Leaf.
 *
 * This drives the PRODUCTION plugin mount (`plugin: true`), so the projection,
 * anchor service, recall tools, command surface and idle consumer are the ones
 * a deployment gets. Only the provider is scripted.
 *
 * @module tests/semantic-lifecycle
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import EpistemicFoldPlugin from '../src/plugin.ts'
import { deriveCheckpointResidency, retireCheckpoint } from '../src/checkpoint/residency.ts'
import { registerEpistemicFoldProjection } from '../src/state/projection.ts'
import { mountRuntime } from '../eval/src/runtime-mount.ts'
import { makeTemp } from '../eval/tmp.ts'
import {
  ControlledAdapter,
  MODEL,
  SIGNAL,
  conversation,
  createHarness,
  foldAgent,
  idleAgent,
  type Harness,
  type Session as HarnessSession,
} from './harness.ts'

const PADDING = ` ${'padding '.repeat(160)}`.trimEnd()

function writerReply(handoff: string, deltas: readonly unknown[]): string {
  return [
    '<handoff>', handoff, '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

function constraintDelta(quote: string, statement: string, subjectKey = 'timeout'): Record<string, unknown> {
  return {
    kind: 'constraint',
    subjectKey,
    statement,
    status: 'claimed',
    evidence: [{ quote }],
  }
}

function isWriterCall(options: { readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[] }): boolean {
  const last = options.messages[options.messages.length - 1]
  return last?.content.some(block =>
    block.type === 'text' && block.text?.startsWith('You are the SEMANTIC WRITER')) === true
}

function appendClosedTurn(session: HarnessSession, turn: number, userText: string, assistantText: string): void {
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
      content: [{ type: 'text', text: `${assistantText} ${PADDING}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turn + 1 })
}

async function foldOpen(h: Harness, session: HarnessSession): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle!.rendered.text
}

/** The exact Phase Exit operations: record the retirement, then honour it. */
function retireAndRemove(session: HarnessSession, checkpointId: string): void {
  const outcome = retireCheckpoint(session as never, checkpointId, 'phase complete')
  expect(outcome.written).toBe(true)
  const site = deriveCheckpointResidency(session as never).sites
    .find(candidate => candidate.checkpointId === checkpointId)
  if (site?.surfaceSeq === undefined) throw new Error('retired checkpoint has no surface node')
  session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: `[earlier context retired; its archive is still recallable with ref "cp:${checkpointId}"]`,
    }],
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', startSeq: site.surfaceSeq, endSeq: site.surfaceSeq },
    sourceEventSeqs: [site.surfaceSeq],
  } as never)
}

async function recall(h: Harness, session: HarnessSession, checkpointId: string): Promise<string> {
  const result = await h.ctx.tools.execute({
    callId: `call-${randomUUID()}` as never,
    name: 'context_recall',
    arguments: { ref: `cp:${checkpointId}`, depth: 'exact', offset: 0, limit: 10 },
    agent: foldAgent(session),
    signal: SIGNAL,
  })
  expect(result.isError).toBe(false)
  return (result.content as readonly { type: string; text?: string }[])
    .map(block => block.text ?? '').join('\n')
}

describe('R31-D2: the lifecycle sequence on the production plugin path', () => {
  it('does not revive a superseded value, does not lose a retired archive, and survives a restart', async () => {
    const root = await makeTemp('ef-r31-life-')
    const bundleRoot = join(root, 'bundles')
    const semanticRoot = join(root, 'semantic')
    const box = { text: writerReply('empty', []) }
    const h = await createHarness(
      { textFor: options => isWriterCall(options) ? box.text : 'digest' },
      {
        plugin: true,
        tools: true,
        systemPrompt: true,
        efConfig: {
          auto: false,
          bundleRoot,
          semanticRoot,
          semanticContinuity: 'active',
          semanticMode: 'rationale',
          semanticWorkingSetTokens: 512,
        },
      },
    )
    const session = conversation(2)
    const firstCheckpoint: string[] = []
    const checkpointIds: string[] = []

    // ---- Leaf 1: record a still-binding constraint.
    box.text = writerReply('The timeout is 30 seconds.', [
      constraintDelta('fixture user 1', 'The timeout is 30 seconds.'),
    ])
    const body1 = await foldOpen(h, session)
    expect(body1).toContain('The timeout is 30 seconds.')
    checkpointIds.push(h.engine.publishedBundle!.checkpointId)
    firstCheckpoint.push(h.engine.publishedBundle!.checkpointId)

    // ---- Leaf 2: carry it, do not re-emit it as changed.
    appendClosedTurn(session, 3, 'Second phase begins.', 'Noted.')
    box.text = writerReply('Continuing.', [])
    const body2 = await foldOpen(h, session)
    expect(body2).toContain('State from earlier folds')
    expect(body2).toContain('The timeout is 30 seconds.')
    checkpointIds.push(h.engine.publishedBundle!.checkpointId)

    // ---- Semantic revision: the later value wins, the earlier one does not revive.
    appendClosedTurn(session, 4, 'The timeout is now 60 seconds.', 'Updated.')
    box.text = writerReply('The timeout changed.', [
      constraintDelta('The timeout is now 60 seconds.', 'The timeout is 60 seconds.'),
    ])
    const body3 = await foldOpen(h, session)
    expect(body3).toContain('The timeout is 60 seconds.')
    expect(body3).not.toContain('The timeout is 30 seconds.')
    checkpointIds.push(h.engine.publishedBundle!.checkpointId)

    // ---- Root: fold the whole chain, including the frozen checkpoints.
    appendClosedTurn(session, 5, 'Prepare the root fold.', 'Ready.')
    // `compactNow` is the manual/idle path and refuses while a turn is open.
    // This is the harness's own bookkeeping, not the session's: close the open
    // turn for the duration of the command, then reopen the next one.
    session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    await h.engine.compactNow(idleAgent(session), SIGNAL)
    await h.engine.reconcileSemantics(session)
    session.append('turn/start', { turn: 6 })
    expect(h.engine.rootFoldCount).toBe(1)
    const rootBody = h.engine.publishedBundle!.rendered.text
    expect(rootBody).toContain('The timeout is 60 seconds.')
    expect(rootBody).not.toContain('The timeout is 30 seconds.')
    const rootCheckpoint = h.engine.publishedBundle!.checkpointId
    checkpointIds.push(rootCheckpoint)

    // ---- Leaf after root: the chain still carries the latest value.
    appendClosedTurn(session, 6, 'Leaf after root.', 'Ready.')
    box.text = writerReply('After root.', [])
    const body4 = await foldOpen(h, session)
    expect(body4).toContain('The timeout is 60 seconds.')
    checkpointIds.push(h.engine.publishedBundle!.checkpointId)

    // ---- Phase Exit: retire + honour on the surface.
    const leafCheckpoint = h.engine.publishedBundle!.checkpointId
    retireAndRemove(session, leafCheckpoint)
    const residency = deriveCheckpointResidency(session as never)
    expect(residency.retired).toBe(1)
    expect(residency.conflicts).toBe(0)
    expect(residency.sites.find(site => site.checkpointId === leafCheckpoint)?.onSurface).toBe(false)

    // ---- Recall after exit: the content is still there, by reference.
    const retiredRecall = await recall(h, session, leafCheckpoint)
    // The leaf's archive holds the messages it folded; the point is that the
    // reference still resolves after the marker left the surface.
    expect(retiredRecall).toContain('Leaf after root')
    const rootRecall = await recall(h, session, rootCheckpoint)
    expect(rootRecall).toContain('60 seconds')
    // The FIRST checkpoint is archived (folded into later ones), not retired;
    // its archive must still be reachable too.
    const earliestRecall = await recall(h, session, firstCheckpoint[0]!)
    expect(earliestRecall).toContain('fixture user 1')

    // ---- Restart: new Context, same journal and bundles, seeded session log.
    const ctx2 = new Context()
    mountRuntime(ctx2, { systemPrompt: true, tools: true })
    registerEpistemicFoldProjection(ctx2)
    ctx2.llm.registerAdapter([MODEL], new ControlledAdapter(1_000_000, h.control))
    const restartedPlugin = new EpistemicFoldPlugin(ctx2, {
      mode: 'legacy',
      auto: false,
      semanticContinuity: 'active',
      semanticMode: 'rationale',
      semanticWorkingSetTokens: 512,
      bundleRoot,
      semanticRoot,
    })
    const restarted = restartedPlugin.engine
    const restartedSession = Session.create(
      SessionId(session.id),
      session.snapshotEvents(),
    ) as unknown as HarnessSession
    const reconcile = await restarted.reconcileSemantics(restartedSession)
    expect(reconcile.health).toBe('ready')

    // The retirement is a session fact; the restart must not turn it back into
    // a resident checkpoint, and the old value must not return.
    const restartedResidency = deriveCheckpointResidency(restartedSession as never)
    expect(restartedResidency.retired).toBe(1)
    expect(restartedResidency.conflicts).toBe(0)

    // ---- Leaf after restart: the current value is still 60, never 30.
    appendClosedTurn(restartedSession, 7, 'After restart.', 'Ready.')
    h.control.semantic.textFor = options => isWriterCall(options)
      ? writerReply('After restart.', [])
      : 'digest'
    const nodes = [...restartedSession.surface.nodes]
    const frontier = locateFoldFrontier(restartedSession)
    const start = nodes[frontier.firstOpenPosition]
    const end = nodes[nodes.length - 1]
    await restarted.compactRegion(start!, end!, foldAgent(restartedSession), SIGNAL)
    await restarted.reconcileSemantics(restartedSession)
    const afterRestart = restarted.publishedBundle!.rendered.text
    expect(afterRestart).toContain('The timeout is 60 seconds.')
    expect(afterRestart).not.toContain('The timeout is 30 seconds.')

    // Exact recall still resolves the retired checkpoint after the restart.
    const recalledAfter = await ctx2.tools.execute({
      callId: `call-${randomUUID()}` as never,
      name: 'context_recall',
      arguments: { ref: `cp:${leafCheckpoint}`, depth: 'exact', offset: 0, limit: 2 },
      agent: foldAgent(restartedSession),
      signal: SIGNAL,
    })
    expect(recalledAfter.isError).toBe(false)
    expect((recalledAfter.content as readonly { type: string; text?: string }[])
      .map(block => block.text ?? '').join('\n')).toContain('Leaf after root')

    // ---- Idempotent retirement: asking again refuses, and does not move the record.
    const again = retireCheckpoint(restartedSession as never, leafCheckpoint)
    expect(again).toMatchObject({ written: false, refusal: 'already-retired' })
  }, 60_000)
})
