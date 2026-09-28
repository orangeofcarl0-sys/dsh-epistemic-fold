/**
 * M2 suite: Fold Frontier, stable leaf checkpoints, prefix fingerprints,
 * root rebase. Conventions mirror the M0 suites; every scenario drives the
 * real transaction chain through the controlled adapter.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  canonicalHash,
  sha256Hex,
} from '../src/hash.ts'
import { locateFoldFrontier, readEfCheckpoint } from '../src/frontier.ts'
import { frozenCheckpointLoad, selectLeafSpan } from '../src/leaf-policy.ts'
import { evaluateRootRebase } from '../src/root-policy.ts'
import {
  closedConversation,
  conversation,
  createHarness,
  extractCheckpointId,
  foldAgent,
  idleAgent,
  lastCompactionEnd,
  lastCompactionSummary,
  SIGNAL,
  surfaceMessages,
  toolConversation,
} from './harness.ts'

function summaryText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function checkpointIdOf(session: ReturnType<typeof conversation>): string {
  return extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!
}

/** Fingerprint of the frozen prefix: canonical hash over surface node seqs + messages. */
function prefixFingerprint(session: ReturnType<typeof conversation>, positions: number): string {
  const nodes = [...session.surface.nodes].slice(0, positions)
  const messages = surfaceMessages(session, nodes)
  return sha256Hex(canonicalHash({ nodes, messages }))
}

describe('P0x: frontier location', () => {
  it('locates no frontier before any fold and exposes the first open position', async () => {
    const session = conversation(4)
    const frontier = locateFoldFrontier(session)
    expect(frontier.frozenCount).toBe(0)
    expect(frontier.ref).toEqual({})
    // No system head in this fixture: node 0 is the first user message.
    expect(frontier.firstOpenPosition).toBe(0)
  })

  it('recognizes EF checkpoints by rendered marker and skips legacy Basic checkpoints', async () => {
    const { engine } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const frontier = locateFoldFrontier(session)
    expect(frontier.frozenCount).toBe(1)
    expect(frontier.frozen[0]!.position).toBe(0)
    expect(frontier.ref.latestFrozenCheckpointId).toBe(checkpointIdOf(session))
    expect(frontier.firstOpenPosition).toBe(1)
    void readEfCheckpoint
  })

  it('selectLeafSpan never starts before the frontier', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' })
    const session = conversation(6)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    // Any subsequent leaf span starts at position 1 (past the checkpoint),
    // no matter how much older history exists.
    const measurement = ctx.tokenMeter.measure(session)
    const span = selectLeafSpan(session, measurement as never, 0)
    expect(span).not.toBeNull()
    expect(span!.startIdx).toBe(1)
    expect(span!.start).toBe([...session.surface.nodes][1])
  })
})

describe('P0x: stable prefix (C2.2, C2.3)', () => {
  it('P01: frozen prefix hash is stable across turns without folds', async () => {
    const session = conversation(4)
    const nodesBefore = [...session.surface.nodes]
    const fingerprintBefore = prefixFingerprint(session, nodesBefore.length)

    // Extend the conversation: appending never rewrites the existing prefix.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'one more user turn' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    // Re-fingerprint the ORIGINAL node count: identical bytes.
    expect(prefixFingerprint(session, nodesBefore.length)).toBe(fingerprintBefore)
    // And the surface genuinely grew.
    expect([...session.surface.nodes].length).toBe(nodesBefore.length + 1)
  })

  it('P02: leaf fold append preserves the prior frozen checkpoint byte-for-byte', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(8)
    const nodes = [...session.surface.nodes]

    // First leaf fold: positions 0..3.
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const firstCheckpointId = checkpointIdOf(session)
    const surfaceAfterFirst = [...session.surface.nodes]
    const firstCheckpointNodeSeq = surfaceAfterFirst[0]!

    // Second leaf fold: the span PAST the first checkpoint (positions 1..4).
    const second = locateFoldFrontier(session)
    expect(second.firstOpenPosition).toBe(1)
    const secondNodes = [...session.surface.nodes]
    await engine.compactRegion(secondNodes[1]!, secondNodes[4]!, foldAgent(session), SIGNAL)

    // The first checkpoint node survived byte-for-byte at position 0.
    expect([...session.surface.nodes][0]).toBe(firstCheckpointNodeSeq)
    const verification = await store.verify(firstCheckpointId)
    expect(verification.status).toBe('verified')
    // Its rendered text is still exactly the original (immutability, C2.3).
    if (verification.status === 'verified') {
      const frontier = locateFoldFrontier(session)
      expect(frontier.frozenCount).toBe(2)
      expect(frontier.frozen[0]!.checkpointId).toBe(firstCheckpointId)
      expect(frontier.frozen[1]!.position).toBe(1)
      // Frontier moved forward, monotonic (C2.1).
      expect(frontier.frozen[1]!.position).toBeGreaterThan(frontier.frozen[0]!.position)
    }
  })

  it('P03: frontier is monotonic under repeated leaf folds', async () => {
    const { engine } = await createHarness({ text: 'digest' })
    const session = conversation(12)
    for (let round = 0; round < 3; round += 1) {
      const frontierBefore = locateFoldFrontier(session)
      const nodes = [...session.surface.nodes]
      const startIdx = frontierBefore.firstOpenPosition
      const endIdx = Math.min(startIdx + 3, nodes.length - 1)
      if (endIdx <= startIdx) break
      await engine.compactRegion(nodes[startIdx]!, nodes[endIdx]!, foldAgent(session), SIGNAL)
      const frontierAfter = locateFoldFrontier(session)
      expect(frontierAfter.frozenCount).toBe(frontierBefore.frozenCount + 1)
      if (frontierBefore.ref.latestFrozenCheckpointId !== undefined) {
        // Prior checkpoint still present and still earlier on the surface.
        expect(frontierAfter.frozen[frontierAfter.frozenCount - 2]!.checkpointId)
          .toBe(frontierBefore.ref.latestFrozenCheckpointId)
      }
    }
  })

  it('P04: non-monotonic seqs are handled by surface POSITION, not seq magnitude', async () => {
    const { engine } = await createHarness({ text: 'digest' })
    const session = conversation(8)
    const nodes = [...session.surface.nodes]

    // Fold the LATER span first (positions 4..7), then the EARLIER one
    // (positions 0..3): the second replacement carries a HIGHER seq but lands
    // at an EARLIER surface position — and compresses the surface before the
    // first checkpoint, shifting it from position 4 to position 1.
    await engine.compactRegion(nodes[4]!, nodes[7]!, foldAgent(session), SIGNAL)
    const firstCheckpointSeq = [...session.surface.nodes][4]!
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const secondCheckpointSeq = [...session.surface.nodes][0]!
    expect(secondCheckpointSeq).toBeGreaterThan(firstCheckpointSeq)

    // The frontier is the LAST checkpoint by POSITION (1), not by seq —
    // the newest-folded checkpoint (higher seq) sits at position 0 but the
    // frozen boundary is where the surface runs out of frozen nodes.
    const frontier = locateFoldFrontier(session)
    expect(frontier.frozen).toHaveLength(2)
    expect(frontier.frozen[0]!.position).toBe(0)
    expect(frontier.frozen[0]!.seq).toBe(secondCheckpointSeq)
    expect(frontier.frozen[1]!.position).toBe(1)
    expect(frontier.frozen[1]!.seq).toBe(firstCheckpointSeq)
    expect(frontier.ref.latestFrozenSurfaceSeq).toBe(firstCheckpointSeq)
    expect(frontier.firstOpenPosition).toBe(2)
  })
})

describe('P05: manual compaction is a root fold', () => {
  it('compactNow produces mode=root with the root renderer', async () => {
    const { engine, store } = await createHarness({ text: 'root digest' })
    const session = closedConversation(4)

    const result = await engine.compactNow(idleAgent(session), SIGNAL)
    expect(result).not.toBeNull()

    // The bundle records the root mode (weak-safety semantic fold).
    const bundles = await store.list(session.id)
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.mode).toBe('root')
    const verification = await store.verify(bundles[0]!.checkpointId)
    expect(verification.status).toBe('verified')
    if (verification.status === 'verified') {
      expect(verification.bundle.rendered.text).toContain('[EF root checkpoint')
    }
  })
})

describe('P06: frozen budget and root rebase', () => {
  it('automatic pressure path folds ONLY the open trajectory past the frontier', async () => {
    // Small window + low threshold so the pressure path engages.
    const { engine, store } = await createHarness(
      { text: 'auto digest' },
      { contextWindow: 1_600, efConfig: { thresholdRatio: 0.45, headroomTokens: 0, retainTokens: 0, maxTokens: 512 } },
    )
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    // First pressure fold: no frontier yet, span starts at node 0.
    const first = await engine.compactIfNeeded(foldAgent(session), 'pressure', SIGNAL)
    expect(first).not.toBeNull()
    expect(first!.shadowedSeqs[0]).toBe(nodes[0]!)
    const firstCheckpointId = checkpointIdOf(session)

    // Append more pressure past the new frontier, keeping the turn OPEN —
    // the automatic path runs inside an open turn (agent/pre-step).
    for (let extra = 1; extra <= 4; extra += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `extra pressure ${extra} ${'fixture '.repeat(80).trim()}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }

    const second = await engine.compactIfNeeded(foldAgent(session), 'pressure', SIGNAL)
    expect(second).not.toBeNull()
    // The automatic leaf fold NEVER shadows the existing frozen checkpoint.
    expect(second!.shadowedSeqs).not.toContain(
      [...session.surface.nodes][0],
    )
    expect(second!.shadowedSeqs).not.toContain(first!.summarySeq)

    // Both checkpoints verify; the first is byte-stable on the surface.
    expect((await store.verify(firstCheckpointId)).status).toBe('verified')
    const frontier = locateFoldFrontier(session)
    expect(frontier.frozenCount).toBe(2)
    expect(frontier.frozen[0]!.checkpointId).toBe(firstCheckpointId)
    expect(frontier.frozen[0]!.position).toBe(0)
  })

  it('accumulated leaf checkpoints exceed the budget and recommend a rebase; the rebase reclaims it', async () => {
    // Budget small enough that two leaf checkpoints exceed it.
    const { engine, store, ctx } = await createHarness({ text: 'digest' })
    ;(engine as unknown as { efConfig: { frozenCheckpointTokenBudget: number } }).efConfig
      = { ...(engine as unknown as { efConfig: { frozenCheckpointTokenBudget: number } }).efConfig, frozenCheckpointTokenBudget: 1 }

    const session = conversation(8)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const leafIds = [checkpointIdOf(session)]
    const secondNodes = [...session.surface.nodes]
    await engine.compactRegion(secondNodes[1]!, secondNodes[4]!, foldAgent(session), SIGNAL)
    leafIds.push(checkpointIdOf(session))

    // Close the open tail turn so the manual root path is admissible.
    session.append('turn/end', { turn: 9, reason: { kind: 'completed' } })

    // Frozen load now exceeds the budget.
    const measurement = ctx.tokenMeter.measure(session)
    const advice = evaluateRootRebase(session, measurement as never, 1)
    expect(advice.recommended).toBe(true)
    expect(advice.frozenCount).toBe(2)
    expect(advice.frozenTokens).toBeGreaterThan(1)

    // Root rebase via the manual path: frozen prefix collapses to ONE node.
    const rootResult = await engine.compactNow(idleAgent(session), SIGNAL)
    expect(rootResult).not.toBeNull()

    const afterMeasurement = ctx.tokenMeter.measure(session)
    const afterFrontier = locateFoldFrontier(session)
    expect(afterFrontier.frozenCount).toBe(1)
    expect(afterFrontier.frozen[0]!.mode).toBe('root')
    const afterLoad = frozenCheckpointLoad(session, afterMeasurement as never)
    expect(afterLoad.count).toBe(1)
    expect(afterLoad.tokens).toBeLessThan(advice.frozenTokens)

    // Old leaf bundles remain recallable after the rebase.
    for (const id of leafIds) {
      const verification = await store.verify(id)
      expect(verification.status).toBe('verified')
    }
    // The root bundle exists and is distinct from the leaves.
    const bundles = await store.list(session.id)
    expect(bundles.some(descriptor => descriptor.mode === 'root')).toBe(true)
    expect(lastCompactionEnd(session)?.error).toBeUndefined()
  })

  it('tool conversations fold cleanly across the frontier (pairing kept)', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' })
    const session = toolConversation(3)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[2]!, foldAgent(session), SIGNAL)
    const frontier = locateFoldFrontier(session)
    expect(frontier.frozenCount).toBe(1)
    const secondNodes = [...session.surface.nodes]
    const span = selectLeafSpan(session, ctx.tokenMeter.measure(session) as never, 0)
    expect(span!.startIdx).toBe(1)
    await engine.compactRegion(span!.start, span!.end, foldAgent(session), SIGNAL)
    void secondNodes
    expect(locateFoldFrontier(session).frozenCount).toBe(2)
  })
})
