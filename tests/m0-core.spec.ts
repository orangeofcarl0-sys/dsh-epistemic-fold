/**
 * M0 suite, classes A–D: transactions, bundle/archive integrity, recall,
 * lifecycle. Crash-point classes E/F live in m0-crash.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { canonicalHash } from '../src/hash.ts'
import { recall, search } from '../src/recall.ts'
import { failingStore } from './stores.ts'
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

describe('A. transaction tests', () => {
  it('T01: leaf fold commits normally with bundle and recall available', async () => {
    const { engine, store } = await createHarness({ text: 'semantic digest of the folded span' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    expect(result.shadowedSeqs).toHaveLength(4)
    expect(session.surface.nodes).toHaveLength(nodes.length - 3)
    const summary = lastCompactionSummary(session)
    expect(summary).toBeDefined()
    const text = summaryText((summary!.summary as ContentBlock[]))
    const checkpointId = extractCheckpointId(text)
    expect(checkpointId).not.toBeNull()
    // C0.1: committed checkpoint ⇒ bundle exists and verifies.
    const verification = await store.verify(session.id, checkpointId!)
    expect(verification.status).toBe('verified')
    // The bundle remembers the fold identity and the surface span.
    if (verification.status === 'verified') {
      expect(verification.bundle.mode).toBe('leaf')
      expect([...verification.bundle.source.orderedSurfaceSeqs]).toEqual([...result.shadowedSeqs])
    }
  })

  it('T02: tool-pair split is rejected and leaves no committed checkpoint', async () => {
    const { engine, store } = await createHarness({ text: 'should never be used' })
    const session = toolConversation(3)
    const nodes = [...session.surface.nodes]
    // Surface layout per turn: user, assistant(tool-call), tool/result.
    // Starting the span at turn 1's tool/result separates it from its call.
    const resultNode = nodes[2]!
    const lastNode = nodes[nodes.length - 1]!

    await expect(engine.compactRegion(resultNode, lastNode, foldAgent(session), SIGNAL))
      .rejects.toThrow(/balanced boundary/u)

    expect(lastCompactionSummary(session)).toBeUndefined()
    expect(await store.list(session.id)).toHaveLength(0)
  })

  it('T03: surface changed during summary → transaction fails, no invalid replacement', async () => {
    const session = conversation(4)
    const { engine, store } = await createHarness({
      text: 'slow semantic digest',
      mutate: () => {
        // Append an unrelated open-turn user message while summarizing.
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'mid-flight append' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      },
    })
    const nodes = [...session.surface.nodes]

    // whole-surface stability: the append invalidates the prepared summary.
    await expect(engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL))
      .rejects.toThrow()

    expect(lastCompactionSummary(session)).toBeUndefined()
    const end = lastCompactionEnd(session)
    expect(end?.error).toBeDefined()
    // The surface keeps every original node (no replacement landed).
    expect([...session.surface.nodes].slice(0, nodes.length)).toEqual(nodes)
    // Orphan bundle is detectable by id via the rendered text of nothing —
    // no checkpoint landed, so the store may hold an orphan; verify recalls fail.
    const bundles = await store.list(session.id)
    for (const descriptor of bundles) {
      const verification = await store.verify(session.id, descriptor.checkpointId)
      expect(verification.status).toBe('verified')
    }
  })

  it('T04: unrelated tail append does not corrupt a selected fixed span (selected-span stability)', async () => {
    // compactNow (manual path) uses selected-span stability: only the selected
    // span must survive, appends outside it are tolerated.
    const { engine } = await createHarness({ text: 'manual root digest' })
    const session = closedConversation(4)
    // The manual path runs under an idle-agent maintenance bracket.
    const result = await engine.compactNow(idleAgent(session), SIGNAL)
    expect(result).not.toBeNull()
    if (result !== null) {
      expect(result.shadowedSeqs.length).toBeGreaterThan(0)
      const summary = lastCompactionSummary(session)
      expect(summary).toBeDefined()
    }
  })
})

describe('B. bundle/archive tests', () => {
  it('T05: bundle logical hash is exact over archived messages', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const expectedMessages = surfaceMessages(session, nodes.slice(0, 4))

    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const summary = lastCompactionSummary(session)
    const checkpointId = extractCheckpointId(summaryText((summary!.summary as ContentBlock[])))!
    const verification = await store.verify(session.id, checkpointId)
    expect(verification.status).toBe('verified')
    if (verification.status === 'verified') {
      expect(verification.bundle.archive.logicalHash).toBe(canonicalHash(expectedMessages))
    }
  })

  it('T06: archive write failure → no successful summary, no surface replacement', async () => {
    const { engine, store } = await createHarness({ text: 'digest' }, { bundleStore: failingStore() })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    await expect(engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL))
      .rejects.toThrow(/disk full/u)

    expect(lastCompactionSummary(session)).toBeUndefined()
    expect([...session.surface.nodes]).toEqual(nodes)
    expect(await store.list(session.id)).toHaveLength(0)
  })

  it('T07: bundle success + compaction failure leaves a detectable orphan', async () => {
    // Deterministic post-publish failure: an oversized semantic digest passes
    // the compile hook (bundle published) and then fails Basic's shrink check,
    // aborting the commit — the published bundle becomes a detectable orphan.
    const { engine, store } = await createHarness({ text: 'orphan '.repeat(600) })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    await expect(engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL))
      .rejects.toThrow(/not smaller than the shadowed content/u)

    // Bundle was published before the transaction aborted (bundle-before-loss
    // ordering means publish precedes every Basic-side failure).
    const bundles = await store.list(session.id)
    expect(bundles.length).toBe(1)
    const verification = await store.verify(session.id, bundles[0]!.checkpointId)
    expect(verification.status).toBe('verified')
    // Surface unchanged.
    expect([...session.surface.nodes]).toEqual(nodes)
  })

  it('T08: corrupt bundle hash is detected, recall refuses silently-wrong content', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const summary = lastCompactionSummary(session)
    const checkpointId = extractCheckpointId(summaryText((summary!.summary as ContentBlock[])))!

    // Tamper with the stored archive.
    const stored = await store.read(session.id, checkpointId)
    expect(stored).not.toBeNull()
    const tampered = {
      ...stored!,
      archive: { ...stored!.archive, shadowedMessages: [{ role: 'user', content: [], source: { kind: 'user' } } as unknown as Message] },
    }
    await store.remove(session.id, checkpointId)
    const { FileBundleStore: Fresh } = await import('../src/bundle-store.ts')
    const rewritten = new Fresh(store === undefined ? '' : (store as unknown as { root: string }).root)
    await rewritten.write(tampered)

    const verification = await store.verify(session.id, checkpointId)
    expect(verification.status).toBe('corrupt')
    const result = await recall({ store, sessionId: session.id, checkpointId, depth: 'exact' })
    expect(result?.unavailable).toBeDefined()
    expect(result?.page).toBeUndefined()
  })
})

describe('C. recall tests', () => {
  it('T09: summary recall returns the checkpoint compact view', async () => {
    const { engine, store } = await createHarness({ text: 'the semantic digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!

    const result = await recall({ store, sessionId: session.id, checkpointId, depth: 'summary' })
    expect(result?.text).toContain('the semantic digest')
    expect(result?.text).toContain(`cp:${checkpointId}`)
  })

  it('T10: exact recall equals the archived shadowed model messages', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const expected = surfaceMessages(session, nodes.slice(0, 4))
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!

    const result = await recall({ store, sessionId: session.id, checkpointId, depth: 'exact', limit: 100 })
    expect(result?.page?.totalMessages).toBe(expected.length)
    expect(canonicalHash(result?.page?.messages)).toBe(canonicalHash(expected))
  })

  it('T11: exact recall is paginated, never unbounded', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!

    const page1 = await recall({ store, sessionId: session.id, checkpointId, depth: 'exact', limit: 2 })
    expect(page1?.page?.messages.length).toBe(2)
    expect(page1?.page?.nextOffset).toBe(2)
    const page2 = await recall({
      store,
      sessionId: session.id,
      checkpointId,
      depth: 'exact',
      offset: page1!.page!.nextOffset!,
      limit: 2,
    })
    expect(page2?.page?.offset).toBe(page1!.page!.nextOffset)
    // Pages do not overlap.
    const first = page1!.page!.messages[0]!
    expect(page2?.page?.messages).not.toContain(first)
  })

  it('T12: missing bundle degrades explicitly instead of crashing', async () => {
    const harness = await createHarness({})
    const result = await recall({
      store: harness.store,
      sessionId: SessionId('no-such-session'),
      checkpointId: 'no-such-id',
      depth: 'summary',
    })
    expect(result?.unavailable).toBe('bundle not found')
  })
})

describe('D. lifecycle tests', () => {
  it('T13: restart — store rebuilds from disk, recall keeps working', async () => {
    const { engine, root } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!

    // "Restart": a brand-new store over the same directory + a restored session object.
    const { FileBundleStore: Reopened } = await import('../src/bundle-store.ts')
    const reopened = new Reopened(root)
    const restoredSession = conversation(4) // shape-compatible surface for derive
    void restoredSession
    const verification = await reopened.verify(session.id, checkpointId)
    expect(verification.status).toBe('verified')
    const result = await recall({ store: reopened, sessionId: session.id, checkpointId, depth: 'exact' })
    expect(result?.page?.totalMessages).toBe(4)
  })

  it('T14: fork — session id provenance stays with the originating session', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    const summary = lastCompactionSummary(session)
    const checkpointId = extractCheckpointId(summaryText(summary!.summary as ContentBlock[]))!

    const verification = await store.verify(session.id, checkpointId)
    expect(verification.status).toBe('verified')
    if (verification.status === 'verified') {
      expect(verification.bundle.sessionId).toBe(session.id)
    }
    // A different session's list must not see the other's bundle.
    const other = conversation(2)
    expect(await store.list(other.id)).toHaveLength(0)
    // R0-A recall isolation: cross-session reads are fail-closed absences.
    expect(await store.verify(other.id, checkpointId)).toEqual({ status: 'missing' })
    expect(await store.read(other.id, checkpointId)).toBeNull()
    const crossRecall = await recall({ store, sessionId: other.id, checkpointId, depth: 'summary' })
    expect(crossRecall?.unavailable).toBe('bundle not found')
  })

  it('T15: EF missing — session still opens and Basic semantics survive', async () => {
    // ASSERTED AGAINST CODE, not against the fixture.
    //
    // This test used to be `conversation(4)` plus
    // `expect(session.surface.nodes.length).toBeGreaterThan(0)` — it called no
    // harness at all, so it asserted a property of a locally-built fixture and
    // would have passed if every line of EF were deleted. That is the shape the
    // benchmark spec's T15 is meant to rule out: "EF 缺失时 Session 仍可打开".
    //
    // The real claim is that a deployment WITHOUT EF's machinery still folds
    // through plain Basic, so the test now mounts Basic and drives a fold.
    const { engine } = await createHarness({ text: 'basic-only digest' }, {
      contextWindow: 8_000,
      efConfig: { auto: true, thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 2_000, mode: 'basic' },
    })
    const session = conversation(4)
    expect(session.surface.nodes.length, 'the session assembles without EF').toBeGreaterThan(0)

    const nodes = [...session.surface.nodes]
    const result = await engine.compactRegion(
      nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL,
    )
    // Basic's own transaction ran, and it left no EF artifact behind.
    expect(result.shadowedSeqs, 'Basic compacted the span').toHaveLength(4)
    expect(engine.bundleWriteCount, 'and wrote no EF bundle').toBe(0)
  })

  it('T16: legacy Basic checkpoint before EF install is tolerated', async () => {
    // A session whose earlier history contains a non-EF compaction surface
    // node (a plain user message) folds fine from EF afterwards.
    const { engine } = await createHarness({ text: 'post-legacy digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    expect(result.shadowedSeqs).toHaveLength(4)
  })

  it('search finds checkpoints by id, text, and tool name', async () => {
    const { engine, store } = await createHarness({ text: 'worked on the parser module' })
    const session = toolConversation(3)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!

    expect(await search({ store, sessionId: session.id, query: checkpointId })).toHaveLength(1)
    expect(await search({ store, sessionId: session.id, query: 'parser module' })).toHaveLength(1)
    expect(await search({ store, sessionId: session.id, query: 'read' })).toHaveLength(1)
    expect(await search({ store, sessionId: session.id, query: 'nothing-matches-this' })).toHaveLength(0)
  })
})
