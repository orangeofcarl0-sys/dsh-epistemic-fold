/**
 * R0-A acceptance suite: cross-layer closure added on top of the M0/M2/M3a
 * suites — checkpoint marker protocol, frontier hard invariant, recall
 * isolation, commit records, authority runtime gate, disjoint rendering,
 * semantic profiles, and durable audit metadata.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  createAnchorService,
} from '../src/anchor-service.ts'
import {
  normalizeCheckpointRef,
  parseCheckpointMarker,
  encodeCheckpointMarker,
} from '../src/checkpoint-marker.ts'
import {
  conversation,
  createHarness,
  extractCheckpointId,
  foldAgent,
  idleAgent,
  lastCompactionSummary,
  SIGNAL,
  toolConversation,
  type Session,
} from './harness.ts'
import { projectForCheckpoint } from '../src/renderer.ts'
import { emptyCurrentState } from '../src/state.ts'
import type { Anchor } from '../src/state.ts'

function summaryText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** Latest compaction/summary event data with the full audit envelope. */
function lastSummaryEnvelope(session: Session): {
  provider: string
  model: string
  llmStreamCall?: boolean
  usage?: unknown
  rawOutput?: unknown[]
  summary: unknown[]
  shadowedSeqs: number[]
} | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)
    if (event?.type === 'compaction/summary') {
      return event.data as never
    }
  }
  return undefined
}

describe('checkpoint marker protocol (R0-A1)', () => {
  it('encode/parse round-trips and ignores body extensions', () => {
    const marker = encodeCheckpointMarker({ checkpointId: 'a'.repeat(36), mode: 'leaf' })
    expect(marker).toBe(`[EF checkpoint v1 mode=leaf id=${'a'.repeat(36)}]`)
    const parsed = parseCheckpointMarker(`${marker}\nCurrent\nEvidence\nOpen · whatever]`)
    expect(parsed).toEqual({ version: 1, checkpointId: 'a'.repeat(36), mode: 'leaf' })
    expect(parseCheckpointMarker('no marker here')).toBeUndefined()
  })

  it('normalizeCheckpointRef accepts the display forms and bare uuids', () => {
    const uuid = 'b'.repeat(36)
    expect(normalizeCheckpointRef(uuid)).toBe(uuid)
    expect(normalizeCheckpointRef(`cp:${uuid}`)).toBe(uuid)
    expect(normalizeCheckpointRef(`checkpoint:${uuid}`)).toBe(uuid)
  })

  it('a structured leaf checkpoint is VISIBLE to the frontier (the cross-layer bug)', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' })
    // Register the projection so folds render through the STRUCTURED path —
    // under the old regex this made checkpoints invisible to the frontier.
    const { registerEpistemicFoldProjection } = await import('../src/projection.ts')
    registerEpistemicFoldProjection(ctx)
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const { locateFoldFrontier } = await import('../src/frontier.ts')
    const frontier = locateFoldFrontier(session)
    expect(frontier.frozenCount).toBe(1)
    expect(frontier.frozenPrefixContiguous).toBe(true)
    const text = summaryText(lastCompactionSummary(session)!.summary as ContentBlock[])
    expect(text).toContain('[EF checkpoint v1 mode=leaf id=')
    expect(text).not.toContain(' · state]')
  })
})

describe('frontier hard invariant (R0-A2)', () => {
  it('refuses leaf folds that would compact frozen history', async () => {
    const { engine } = await createHarness({ text: 'digest' })
    const session = conversation(6)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[7]!, foldAgent(session), SIGNAL)
    const after = [...session.surface.nodes]
    await expect(
      engine.compactRegion(after[0]!, after[1]!, foldAgent(session), SIGNAL),
    ).rejects.toThrow(/leaf_before_frontier/u)
  })
})

describe('recall isolation (R0-A3)', () => {
  it('cross-session recall is fail-closed, cp: refs normalize', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(
      summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]),
    )!

    const other = conversation(2)
    const { recall } = await import('../src/recall.ts')
    expect((await store.verify(other.id, checkpointId)).status).toBe('missing')
    const cross = await recall({ store, sessionId: other.id, checkpointId, depth: 'summary' })
    expect(cross?.unavailable).toBe('bundle not found')

    // The owning session recalls through the DISPLAY ref (cp: prefix).
    const own = await recall({
      store,
      sessionId: session.id,
      checkpointId: `cp:${checkpointId}`,
      depth: 'summary',
    })
    expect(own?.text).toBeDefined()
    expect(own?.text).toContain('digest')
  })
})

describe('FoldCommitRecord (R0-A4)', () => {
  it('leaf fold records the exact durable mutation facts', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(
      summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]),
    )!

    const record = await store.readCommitRecord(session.id, checkpointId)
    expect(record).not.toBeNull()
    expect(record!.checkpointId).toBe(checkpointId)
    expect(record!.mode).toBe('leaf')
    expect(record!.compactionId).toBe(result.compactionId)
    expect([...record!.shadowedSeqs]).toEqual([...result.shadowedSeqs])
    expect(record!.summarySeq).toBe(result.summarySeq)
    expect(record!.endSeq).toBe(result.endSeq)
  })

  it('root fold (manual) records a commit record with root mode', async () => {
    const { engine, store } = await createHarness({ text: 'root digest' })
    const session = toolConversation(3)
    // Close the open tail turn — the manual path requires no open turn.
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    const result = await engine.compactNow(idleAgent(session), SIGNAL)
    expect(result).not.toBeNull()
    const bundles = await store.list(session.id)
    const rootBundles = bundles.filter(descriptor => descriptor.mode === 'root')
    expect(rootBundles).toHaveLength(1)
    const record = await store.readCommitRecord(session.id, rootBundles[0]!.checkpointId)
    expect(record!.mode).toBe('root')
    expect(record!.compactionId).toBe(result!.compactionId)
  })
})

describe('authority runtime gate (R0-A5)', () => {
  it('refuses normative claims grounded only by assistant prose', () => {
    const session = conversation(2)
    // conversation(2): the second turn's assistant/message lands at seq 10
    // (turn 2 carries no request header).
    const assistantSeq = 10
    expect(session.eventAt(assistantSeq as never)?.type).toBe('assistant/message')
    const service = createAnchorService()
    // The claim cites ONLY assistant prose, which grounds hypothesis/decision
    // but never normative — the gate refuses with the grounding diagnostic.
    expect(() => service.declare(session, {
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'api' },
      value: 'keep public API (as claimed by the assistant)',
      authority: 'normative',
      sourceRefs: [{ seq: assistantSeq as never }],
    })).toThrow(/not grounded by its cited sources/)
  })

  it('accepts normative constraints grounded by real user messages', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' })
    const { registerEpistemicFoldProjection, currentFoldState } = await import('../src/projection.ts')
    registerEpistemicFoldProjection(ctx)
    const session = conversation(2)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Do not change public API.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const service = createAnchorService()
    const anchor = service.declare(session, {
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'api' },
      value: 'Do not change public API.',
      authority: 'normative',
      sourceRefs: [{ seq: (session.seq - 1) as never }],
    })
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)
    const state = currentFoldState(ctx, session)
    expect(Object.values(state.constraints)[0]!.id).toBe(anchor.id)
  })

  it('refuses VERIFIED transitions grounded by assistant prose (Evidence Overrides Narrative)', () => {
    const session = toolConversation(1, { failTurns: [1] })
    const service = createAnchorService()
    // The assistant claims the failure is fixed — narrative cannot verify.
    const assistantSeq = session.seq // next seq would be an assistant message
    void assistantSeq
    expect(() => service.verifyFailure(session, 'failure:call-1', [{ seq: (session.seq - 1) as never }]))
      .toThrow(/VERIFIED refused/u)
  })

  it('accepts VERIFIED transitions grounded by successful tool results', () => {
    const session = toolConversation(1, { failTurns: [1] })
    const service = createAnchorService()
    // A successful tool/result event IS empirical evidence.
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('retest-1'),
        content: [{ type: 'text', text: 'all tests pass' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    expect(() => service.verifyFailure(session, 'failure:call-1', [{ seq: (session.seq - 1) as never }]))
      .not.toThrow()
  })
})

describe('disjoint checkpoint presentation (R0-A6)', () => {
  it('every anchor appears in exactly one section', () => {
    const state = emptyCurrentState()
    // One evidence anchor that ALSO has a state key (would land in both
    // stateHeads and evidence without the disjoint projection).
    const evidence: Anchor = {
      id: 'anchor-e1',
      kind: 'evidence',
      stateKey: { namespace: 'build', entity: 'current', property: 'status' },
      value: 'passing',
      authority: 'empirical',
      lifecycle: 'active',
      sourceRefs: [],
    }
    const projected = projectForCheckpoint({
      ...state,
      stateHeads: { 'build/current/status': evidence },
      evidence: { 'anchor-e1': evidence },
    })
    const ids = [
      ...projected.current.map(anchor => anchor.id),
      ...projected.evidence.map(anchor => anchor.id),
      ...projected.open.map(anchor => anchor.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
    expect(projected.current).toHaveLength(1)
    expect(projected.evidence).toHaveLength(0) // deduplicated into Current
  })
})

describe('semantic profiles and audit metadata (R0-A6)', () => {
  it('zero-LLM profile: no semantic call, deterministic checkpoint only', async () => {
    const { engine, ctx, control, store } = await createHarness(
      { text: 'should never be called' },
      { efConfig: { semanticMode: 'none' } },
    )
    const { registerEpistemicFoldProjection } = await import('../src/projection.ts')
    registerEpistemicFoldProjection(ctx)
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    expect(control.calls).toHaveLength(0)
    const envelope = lastSummaryEnvelope(session)!
    expect(envelope.provider).toBe('epistemic-fold')
    expect(envelope.model).toBe('deterministic-fallback')
    expect(envelope.llmStreamCall).toBeUndefined()
    const text = summaryText(envelope.summary as ContentBlock[])
    // semanticMode=none produces no rationale, and R2-D omits an empty section
    // rather than emitting a `- (none)` placeholder for it. What must survive
    // is checkpoint identity and the recall pointer.
    expect(text).toContain('[EF checkpoint v1 mode=leaf id=')
    expect(text).toContain('Recall')
    expect(text).toContain('- cp:')
    expect(text).not.toContain('Rationale')
    void store
  })

  it('rationale profile forwards the REAL call envelope into compaction/summary', async () => {
    const { engine, ctx, control } = await createHarness({ text: 'rationale text only' })
    const { registerEpistemicFoldProjection } = await import('../src/projection.ts')
    registerEpistemicFoldProjection(ctx)
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    expect(control.calls).toHaveLength(1)
    const envelope = lastSummaryEnvelope(session)!
    // The REAL routed provider/model and the stream-call marker survive.
    expect(envelope.provider).toBe('test-model')
    expect(envelope.model).toBe('test-model')
    expect(envelope.llmStreamCall).toBe(true)
    expect(Array.isArray(envelope.rawOutput)).toBe(true)
    // Machine sections remain authoritative; the narrative is rationale only.
    const text = summaryText(envelope.summary as ContentBlock[])
    expect(text).toContain('[EF checkpoint v1 mode=leaf id=')
    expect(text).toContain('- rationale text only')
  })
})
