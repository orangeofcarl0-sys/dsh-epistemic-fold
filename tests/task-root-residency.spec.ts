/**
 * Active task root residency: an explicitly declared user contract stays model-visible.
 *
 * ## The measured failure this exists for
 *
 * A real LHTB cell folded its task instruction away in the FIRST leaf fold. The instruction was
 * a user message at surface seq 2; `shadowedSeqs` began `[2, 6, 10, 11, 17, ...]`. The content was
 * archived verbatim and the model was told so, but the only copy was then behind a tool call, and
 * the model made that call twice and recovered zero characters.
 *
 * Recoverable is not recovered, so the fixture here reproduces that shape: a long instruction as
 * the FIRST surface node, ordinary turns behind it, and a fold that would otherwise take it.
 *
 * ## What is covered and what is not
 *
 * LEAF and EMERGENCY folds are covered: EF selects both spans, so a registered root is excluded
 * and the ORIGINAL user event stays where it is.
 *
 * ROOT folds are NOT covered, and the last test in this file PINS that rather than skipping it.
 * `compactNow` delegates to the vendored Basic implementation, which selects its own range and
 * calls `compactSurfaceRegion` directly rather than `this.compactRegion`, so EF has no interception
 * point. See docs/70.
 *
 * @module tests/task-root-residency
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { createHarness, SIGNAL } from './harness.ts'
import { selectLeafSpan } from '../src/leaf-policy.ts'
import { ActiveTaskRootRegistry, resolveActiveTaskRoot, taskRootDigest } from '../src/task-root.ts'
import { recall } from '../src/recall/recall.ts'

const MODEL = 'test-model'

/** The instruction is long on purpose: the real one was 5,741 characters. */
const INSTRUCTION = [
  'You must RECOVER THE TRUE SEMANTICS of an undocumented event-log format and REPAIR a buggy',
  'record-normalisation engine so that it produces the correct canonical output on inputs you',
  'never see. You do this stage by stage, through the evt command-line tool, editing the engine',
  'file with your normal shell tools.',
  '',
  'Requirements: every stage must be verified before the next; the canonical schema must be',
  'derived from observed behaviour rather than assumed; and the engine file is the only artifact',
  'that may change.',
].join('\n') + '\n' + 'detail '.repeat(700)

const EF_CONFIG = { auto: true, thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 8_192 } as const

/**
 * The LHTB shape: a long instruction at the FIRST surface node, then ordinary work, then an open
 * turn so automatic compaction is admissible.
 */
function taskSession(turns = 5, paddingChars = 4_000): Session {
  const session = Session.create(SessionId(`taskroot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: INSTRUCTION }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn > 1) session.append('turn/start', { turn })
    const callId = ToolCallId(`call-${turn}`)
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `probing step ${turn} ` + 'a'.repeat(400) },
          { type: 'tool-call', id: callId, name: 'run_shell', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'run_shell', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        isError: false,
        content: [{ type: 'text', text: 'r'.repeat(paddingChars) }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // The final turn is left OPEN: automatic compaction requires one.
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/**
 * Close the open turn and append `count` more work turns, leaving the last one open.
 *
 * A single leaf fold brings this fixture under the threshold, so a CHAIN of folds needs the
 * surface pushed back up between them — otherwise the second call finds nothing to do and the
 * test passes while exercising exactly one fold.
 */
function addWork(session: Session, openTurn: number, count: number, paddingChars: number): number {
  session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
  for (let index = 0; index < count; index += 1) {
    const turn = openTurn + 1 + index
    const callId = ToolCallId(`more-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `more work ${turn} ` + 'u'.repeat(800) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `step ${turn} ` + 'a'.repeat(400) },
          { type: 'tool-call', id: callId, name: 'run_shell', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'run_shell', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        isError: false,
        content: [{ type: 'text', text: 'r'.repeat(paddingChars) }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    if (index < count - 1) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return openTurn + count
}

/** The surface text of every node, joined — what the model would actually be shown. */
function surfaceText(session: Session): string {
  return session.surface.nodes
    .map(seq => session.deriveEventMessage(session.eventAt(seq)!)!)
    .filter(message => message !== null)
    .map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    .join('\n')
}

/** An agent stub `compactIfNeeded` accepts; mirrors `fold-reachability.spec.ts`. */
function stubAgent(session: Session): never {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
  } as never
}

const drive = (engine: object) => engine as unknown as {
  compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
  compactNow(a: unknown, s: AbortSignal): Promise<unknown>
}

/** Register the session's first surface node as its active task root. */
function registerFirstNode(engine: { registerActiveTaskRoot: (ref: never) => unknown }, session: Session) {
  const seq = session.surface.nodes[0]!
  const message = session.deriveEventMessage(session.eventAt(seq)!)!
  return engine.registerActiveTaskRoot({
    sessionId: session.id,
    sourceSeq: seq,
    sourceDigest: taskRootDigest(message),
    generation: 0,
  } as never) as { status: string; ref: { generation: number } }
}
describe('task root: the loss this exists for', () => {
  it('the instruction IS model-visible before any fold', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession()
    expect(surfaceText(session)).toContain('RECOVER THE TRUE SEMANTICS')
    // And nothing is protecting it: no host declared a root.
    expect(engine.taskRootStatus(session)).toEqual({ status: 'unregistered' })
  })

  it('a leaf fold WITHOUT a registered root takes it off the surface, and it is still archived', async () => {
    const { engine, ctx, store } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession()
    await drive(engine).compactIfNeeded(stubAgent(session), 'pressure', SIGNAL)
    expect(engine.leafFoldCount).toBeGreaterThan(0)
    // 2. the instruction left the model-visible context
    expect(surfaceText(session)).not.toContain('RECOVER THE TRUE SEMANTICS')
    // 3. and it is byte-recoverable, which is exactly why this is a reachability problem
    //    and not a storage one
    const descriptors = await store.list(session.id)
    expect(descriptors.length).toBeGreaterThan(0)
    const page = await recall({
      store, sessionId: session.id, checkpointId: descriptors[0]!.checkpointId,
      depth: 'exact', offset: 0, limit: 1,
    })
    const recovered = (page?.page?.messages[0]?.content ?? [])
      .map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(recovered).toBe(INSTRUCTION)
    // 4. no automatic residency: the engine still reports no root
    expect(engine.taskRootStatus(session)).toEqual({ status: 'unregistered' })
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(0)
  })
})

describe('task root: the registry is explicit and idempotent', () => {
  const sessionId = SessionId('regression-registry')
  const ref = (seq: number, digest: string, generation = 0) => ({
    sessionId, sourceSeq: seq as never, sourceDigest: digest, generation,
  })

  it('registers, treats a repeat as unchanged, and replaces only on a different source', () => {
    const registry = new ActiveTaskRootRegistry()
    expect(registry.get(sessionId)).toBeUndefined()
    const first = registry.register(ref(2, 'd1'))
    expect(first.status).toBe('registered')
    expect(first.ref.generation).toBe(1)
    // A host that re-announces its objective every turn must not inflate the generation:
    // otherwise every turn reads as a new task and the number carries no information.
    const again = registry.register(ref(2, 'd1'))
    expect(again.status).toBe('unchanged')
    expect(again.ref.generation).toBe(1)
    // A DIFFERENT source is a replacement, and only the host can declare one.
    const replaced = registry.register(ref(9, 'd2'))
    expect(replaced.status).toBe('replaced')
    expect(replaced.ref.generation).toBe(2)
    expect(registry.get(sessionId)?.sourceSeq).toBe(9)
    // And the old root is no longer current: re-registering it is a NEW replacement.
    expect(registry.register(ref(2, 'd1')).status).toBe('replaced')
  })

  it('does not let one session read another session root', () => {
    const registry = new ActiveTaskRootRegistry()
    const other = SessionId('regression-other')
    registry.register({ sessionId, sourceSeq: 2 as never, sourceDigest: 'd1', generation: 0 })
    expect(registry.get(other)).toBeUndefined()
    registry.register({ sessionId: other, sourceSeq: 7 as never, sourceDigest: 'd2', generation: 0 })
    expect(registry.get(sessionId)?.sourceDigest).toBe('d1')
    expect(registry.get(other)?.sourceDigest).toBe('d2')
  })

  it('clears a root, and reports whether there was one', () => {
    const registry = new ActiveTaskRootRegistry()
    registry.register({ sessionId, sourceSeq: 2 as never, sourceDigest: 'd1', generation: 0 })
    expect(registry.clear(sessionId)).toBe(true)
    expect(registry.clear(sessionId)).toBe(false)
    expect(registry.get(sessionId)).toBeUndefined()
  })
})

describe('task root: resolution verifies provenance and refuses to guess', () => {
  it('reports digest-mismatch rather than leaving stale content resident', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, efConfig: EF_CONFIG })
    const session = taskSession()
    const seq = session.surface.nodes[0]!
    const message = session.deriveEventMessage(session.eventAt(seq)!)!
    expect(resolveActiveTaskRoot(session, {
      sessionId: session.id, sourceSeq: seq, sourceDigest: 'not-the-digest', generation: 1,
    })).toEqual({ status: 'absent', reason: 'digest-mismatch' })
    // The honest digest resolves, so the refusal above is about the digest and not the event.
    expect(resolveActiveTaskRoot(session, {
      sessionId: session.id, sourceSeq: seq, sourceDigest: taskRootDigest(message), generation: 1,
    })).toEqual({ status: 'resident', position: 0, seq })
    expect(engine.taskRootStatus(session)).toEqual({ status: 'unregistered' })
  })

  it('reports a source that is not on the surface', async () => {
    await createHarness({ text: 'digest' }, { contextWindow: 8_192, efConfig: EF_CONFIG })
    const session = taskSession(2)
    expect(resolveActiveTaskRoot(session, {
      sessionId: session.id, sourceSeq: 999_999 as never, sourceDigest: 'd', generation: 1,
    })).toEqual({ status: 'absent', reason: 'source-not-on-surface' })
  })

  it('refuses a source that is not a user message, so authority cannot be borrowed', async () => {
    await createHarness({ text: 'digest' }, { contextWindow: 8_192, efConfig: EF_CONFIG })
    const session = taskSession(2)
    const assistantSeq = session.surface.nodes.find(seq => {
      const message = session.deriveEventMessage(session.eventAt(seq)!)
      return message !== null && message.role === 'assistant'
    })!
    const message = session.deriveEventMessage(session.eventAt(assistantSeq)!)!
    expect(resolveActiveTaskRoot(session, {
      sessionId: session.id, sourceSeq: assistantSeq, sourceDigest: taskRootDigest(message), generation: 1,
    })).toEqual({ status: 'absent', reason: 'not-a-user-message' })
  })
})
describe('task root: a registered root is excluded from every span EF selects', () => {
  it('a leaf span would take the instruction, and does not once it is protected', async () => {
    const h = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession()
    const measurement = h.ctx.tokenMeter.measure(session)
    const rootSeq = session.surface.nodes[0]!
    const rootIdx = session.surface.nodes.indexOf(rootSeq)
    expect(rootIdx).toBe(0)

    const unprotected = selectLeafSpan(session, measurement, 0)
    expect(unprotected, 'there is a span to take').not.toBeNull()
    expect(unprotected!.startIdx, 'and it begins AT the instruction').toBe(0)

    const protectedSpan = selectLeafSpan(session, measurement, 0, undefined, [rootIdx])
    expect(protectedSpan, 'a span still exists past the root').not.toBeNull()
    expect(protectedSpan!.startIdx, 'but it begins AFTER it').toBeGreaterThan(rootIdx)
    expect(protectedSpan!.start, 'and the root is not in it').not.toBe(rootSeq)
  })
})

describe('task root: residency survives repeated leaf folds', () => {
  it('keeps the ORIGINAL user event visible, exactly once, across many folds', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(8, 3_000)
    const rootSeq = session.surface.nodes[0]!
    registerFirstNode(engine, session)
    expect(engine.taskRootStatus(session)).toEqual({ status: 'resident', position: 0 })

    let openTurn = 9
    for (let round = 0; round < 4; round += 1) {
      await drive(engine).compactIfNeeded(stubAgent(session), 'pressure', SIGNAL)
      // Push the surface back over the threshold so the next round folds again.
      openTurn = addWork(session, openTurn, 3, 3_000)
    }
    expect(engine.leafFoldCount, 'folds actually happened').toBeGreaterThanOrEqual(2)

    // The contract is still where the model can see it, and it is the SAME event: no copy was
    // made, which is what separates residency from re-statement.
    const text = surfaceText(session)
    expect(text).toContain('RECOVER THE TRUE SEMANTICS')
    expect(text.split('RECOVER THE TRUE SEMANTICS').length - 1, 'exactly one copy').toBe(1)
    expect(session.surface.nodes[0], 'the original event is still the first node').toBe(rootSeq)
    expect(engine.taskRootStatus(session).status).toBe('resident')

    // TokenMeter prices it, because it is an ordinary surface node and not a side channel.
    const measurement = ctx.tokenMeter.measure(session)
    const priced = measurement.nodes.find(node => node.seq === rootSeq)
    expect(priced, 'the root is a priced surface node').toBeDefined()
    expect(priced!.tokens).toBeGreaterThan(0)
  })

  it('carries the root as its own token cost, not a free ride', async () => {
    const { ctx } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, efConfig: EF_CONFIG })
    const session = taskSession(2, 500)
    const measurement = ctx.tokenMeter.measure(session)
    const rootSeq = session.surface.nodes[0]!
    const rootNode = measurement.nodes.find(node => node.seq === rootSeq)!
    // ~5.9K characters of instruction: a real, non-trivial recurring cost, reported rather than
    // hidden. This is the number a caller weighs against a weaker locator.
    expect(rootNode.tokens).toBeGreaterThan(1_000)
    expect(rootNode.tokens).toBeLessThan(measurement.totalTokens)
  })
})

// ## Why the flush outcomes are NOT tested here
//
// `tests/harness.ts:247-249` REPLACES `ctx.sessions.flush` with a spy that records the call and
// returns `true`, with the comment "detached test sessions are not store-live". So in THIS harness
// the durability barrier always succeeds, which is exactly why the protected-root tests here
// passed while the real bridge could not commit a manual root at all. The two fixtures differ, and
// the flush semantics are therefore pinned through the BRIDGE (see tests/task-root-bridge.spec.ts
// and docs/73), where the real SessionStore is mounted and the difference is observable.
describe('task root: a PROTECTED root fold keeps it resident', () => {
  it('executes a real root commit whose span excludes the root, and archives only that span', async () => {
    const { engine, store } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(3, 3_000)
    // `compactNow` requires an IDLE session: close the turn the pressure fixture leaves open.
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    const rootSeq = session.surface.nodes[0]!
    registerFirstNode(engine, session)
    expect(engine.taskRootStatus(session)).toEqual({ status: 'resident', position: 0 })
    const surfaceBefore = session.surface.nodes.length

    const result = await drive(engine).compactNow(stubAgent(session), SIGNAL)
    expect(result, 'a protected root really commits').not.toBeNull()
    expect(engine.rootFoldCount).toBe(1)
    expect(session.surface.nodes.length, 'the surface actually shrank').toBeLessThan(surfaceBefore)

    // 1. The contract is still model-visible, and it is still the SAME user event.
    expect(surfaceText(session)).toContain('RECOVER THE TRUE SEMANTICS')
    expect(surfaceText(session).split('RECOVER THE TRUE SEMANTICS').length - 1).toBe(1)
    expect(session.surface.nodes[0], 'still the original node, at position 0').toBe(rootSeq)
    expect(engine.taskRootStatus(session)).toEqual({ status: 'resident', position: 0 })

    // 2. Provenance: the bundle describes the span that was COMMITTED and not the prefix.
    const descriptors = await store.list(session.id)
    const bundle = await store.read(session.id, descriptors[descriptors.length - 1]!.checkpointId)
    expect(bundle).not.toBeNull()
    expect(bundle!.mode).toBe('root')
    expect(bundle!.source.orderedSurfaceSeqs as readonly number[], 'the root seq is NOT in the archive refs')
      .not.toContain(rootSeq)
    const archived = (bundle!.archive.shadowedMessages ?? [])
      .map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    expect(archived.join('\n'), 'and the instruction was not archived by this fold')
      .not.toContain('RECOVER THE TRUE SEMANTICS')
    expect(archived.length, 'the archive is not empty').toBeGreaterThan(0)

    // 3. Exact recall returns what was actually folded, never the protected root.
    const page = await recall({
      store, sessionId: session.id, checkpointId: bundle!.checkpointId, depth: 'exact', offset: 0, limit: 20,
    })
    const recalled = (page?.page?.messages ?? [])
      .map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
      .join('\n')
    expect(recalled).not.toContain('RECOVER THE TRUE SEMANTICS')
    expect(page!.page!.totalMessages).toBe(archived.length)
  })

  it('declines a NON-PREFIX root instead of folding around it', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(3, 3_000)
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    registerFirstNode(engine, session)
    // A first root fold freezes a checkpoint; Task B then sits AFTER it on the surface.
    await drive(engine).compactNow(stubAgent(session), SIGNAL)
    expect(engine.rootFoldCount).toBe(1)
    // Task B must be a LATER USER message, so the refusal under test is about POSITION and not
    // about the node being ineligible for some other reason.
    session.append('turn/start', { turn: 5 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Task B: a different job entirely.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    const taskB = session.surface.nodes[session.surface.nodes.length - 1]!
    const taskBMessage = session.deriveEventMessage(session.eventAt(taskB)!)!
    expect(taskBMessage.role).toBe('user')
    engine.registerActiveTaskRoot({
      sessionId: session.id, sourceSeq: taskB, sourceDigest: taskRootDigest(taskBMessage), generation: 0,
    } as never)
    const before = [...session.surface.nodes]

    const result = await drive(engine).compactNow(stubAgent(session), SIGNAL)
    // Refused, and the surface is untouched: a fold that cannot protect the declared root must
    // not run and break the frontier promise instead.
    expect(result).toBeNull()
    expect(engine.lastRootRefusal).toBe('unsupported-nonprefix')
    expect([...session.surface.nodes]).toEqual(before)
    expect(engine.rootFoldCount, 'no second root committed').toBe(1)
  })

  it('declines a root whose digest no longer matches, rather than claiming protection', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(3, 3_000)
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    const rootSeq = session.surface.nodes[0]!
    engine.registerActiveTaskRoot({
      sessionId: session.id, sourceSeq: rootSeq, sourceDigest: 'not-the-digest', generation: 1,
    } as never)
    const before = [...session.surface.nodes]
    const result = await drive(engine).compactNow(stubAgent(session), SIGNAL)
    expect(result).toBeNull()
    expect(engine.lastRootRefusal).toBe('digest-mismatch')
    expect([...session.surface.nodes]).toEqual(before)
  })

  it('leaves an UNREGISTERED session on the original root path, byte for byte', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(3, 3_000)
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    expect(engine.taskRootStatus(session)).toEqual({ status: 'unregistered' })
    const result = await drive(engine).compactNow(stubAgent(session), SIGNAL)
    // The pre-existing behaviour, including that an unregistered session gets NO protection:
    // nothing was declared, so nothing is promised.
    expect(result).not.toBeNull()
    expect(engine.rootFoldCount).toBe(1)
    expect(engine.lastRootRefusal).toBeUndefined()
    expect(surfaceText(session)).not.toContain('RECOVER THE TRUE SEMANTICS')
  })

  it('a repeated root commits NOTHING, even though it re-attempts the span', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(3, 3_000)
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    registerFirstNode(engine, session)
    await drive(engine).compactNow(stubAgent(session), SIGNAL)
    expect(engine.rootFoldCount).toBe(1)
    const afterFirst = [...session.surface.nodes]

    // The second call DOES select a range -- collapsing the new checkpoint into another one is
    // what a root rebase is for -- and the transaction refuses it because the summary is not
    // smaller. Basic maps that failure to `busy`, and this path inherits the mapping rather than
    // inventing a second one. What matters here is that nothing was COMMITTED.
    await expect(drive(engine).compactNow(stubAgent(session), SIGNAL)).rejects.toMatchObject({
      name: 'ManualCompactionError',
    })
    expect(engine.rootFoldCount, 'NO second root committed').toBe(1)
    expect([...session.surface.nodes], 'and the surface is untouched').toEqual(afterFirst)
    expect(engine.taskRootStatus(session)).toEqual({ status: 'resident', position: 0 })
  })

  it('survives Leaf then Root then Leaf, keeping exactly one copy of the contract', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' }, { contextWindow: 8_192, pruner: true, efConfig: EF_CONFIG })
    const session = taskSession(6, 3_000)
    const rootSeq = session.surface.nodes[0]!
    registerFirstNode(engine, session)

    let openTurn = 7
    for (let round = 0; round < 2; round += 1) {
      await drive(engine).compactIfNeeded(stubAgent(session), 'pressure', SIGNAL)
      openTurn = addWork(session, openTurn, 2, 3_000)
    }
    expect(engine.leafFoldCount).toBeGreaterThanOrEqual(1)
    // A root fold needs an idle surface, and the chain above leaves a turn open.
    session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
    await drive(engine).compactNow(stubAgent(session), SIGNAL)
    expect(engine.rootFoldCount).toBe(1)

    // One more leaf after the root, to prove the protection is not a one-shot.
    openTurn = addWork(session, openTurn, 3, 3_000)
    await drive(engine).compactIfNeeded(stubAgent(session), 'pressure', SIGNAL)

    expect(session.surface.nodes[0], 'the same user event throughout').toBe(rootSeq)
    const text = surfaceText(session)
    expect(text).toContain('RECOVER THE TRUE SEMANTICS')
    expect(text.split('RECOVER THE TRUE SEMANTICS').length - 1, 'exactly one copy').toBe(1)
    expect(engine.taskRootStatus(session)).toEqual({ status: 'resident', position: 0 })
    // And the residency cost is still priced after the root.
    const priced = ctx.tokenMeter.measure(session).nodes.find(node => node.seq === rootSeq)
    expect(priced).toBeDefined()
    expect(priced!.tokens).toBeGreaterThan(1_000)
  })
})