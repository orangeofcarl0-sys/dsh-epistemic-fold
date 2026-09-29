/**
 * RC1.3.1: the temporal retrieval guard.
 *
 * RC1.3 closed the retrieval-ergonomics gap on a probe where all the facts lived
 * in ONE message of ONE checkpoint. That is the easy case. A long task has
 * several checkpoints and several versions of the same fact, and the questions
 * that matter are chronological: which value is CURRENT, and where is the one it
 * superseded?
 *
 * Three defects make search answer that question wrongly, and all three are
 * invisible on the RC1.3 probe:
 *
 *  1. `list()` returns bundles in ascending `createdAt`, and `search` stopped at
 *     `limit` — so with more matching checkpoints than the limit, the NEWEST ones
 *     were the ones dropped. The current value was the first thing lost.
 *  2. `locate` returned the FIRST matching message, so a superseded value inside
 *     a checkpoint always shadowed the correction that followed it.
 *  3. `exactPageOffset` was described as "the page holding the match", which is
 *     only true if the caller happens to use the page size the offset was
 *     computed from.
 *
 * These tests build bundles directly, with EXPLICIT sequence numbers and
 * timestamps, so chronology is controlled rather than inherited from wall-clock
 * timing. They write through the real `FileBundleStore`, so the store's own
 * ordering is genuinely exercised instead of stubbed away.
 *
 * @module tests/rc131-temporal-guard
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'
import { canonicalHash } from '../src/hash.ts'
import {
  compareCheckpointRecencyDescending,
  recall,
  search,
  sourceRangeOf,
} from '../src/recall.ts'
import type { SearchHit } from '../src/recall.ts'
import type { CheckpointBundleV1, FoldBundleStore } from '../src/types.ts'

/**
 * Build a valid bundle with EXPLICIT chronology.
 *
 * The hashes are real, so `FileBundleStore.verify` accepts it — the fixture
 * cannot pass by being corrupt. `createdAt` and `orderedSurfaceSeqs` are inputs
 * rather than clock reads, which is what lets a test put them in conflict.
 */
function bundleOf(options: {
  checkpointId: string
  sessionId: SessionIdType
  seqs: readonly number[]
  messages: readonly Message[]
  renderedText: string
  createdAt: number
}): CheckpointBundleV1 {
  return {
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId: options.checkpointId,
    sessionId: options.sessionId,
    createdAt: options.createdAt,
    mode: 'leaf',
    source: {
      orderedSurfaceSeqs: [...options.seqs] as never,
      sourceDigest: canonicalHash({ seed: options.checkpointId, seqs: options.seqs }),
    },
    archive: {
      shadowedMessages: [...options.messages],
      logicalHash: canonicalHash(options.messages),
    },
    rendered: {
      text: options.renderedText,
      digest: canonicalHash(options.renderedText),
    },
  }
}

/** A plain user message carrying `text`. */
function prose(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * A store holding the given bundles, scoped to one session.
 *
 * Delegates to the REAL `FileBundleStore` so `list()`'s ordering is the
 * production one. That matters: defect 1 lives in how `search` consumes that
 * ordering, and a stub that returned a convenient order would hide it.
 */
async function storeWith(
  bundles: readonly CheckpointBundleV1[],
): Promise<{ store: FoldBundleStore; sessionId: SessionIdType }> {
  const harness = await createHarness({ text: 'digest' })
  const sessionId = bundles[0]!.sessionId
  for (const bundle of bundles) await harness.store.write(bundle)
  return { store: harness.store, sessionId }
}

/** A fixed session id so bundles and queries agree without a Session. */
const SID = SessionId('rc131-temporal')

describe('RC1.3.1: the recency key is the SOURCE chronology, not the clock', () => {
  const bundle = (id: string, seqs: number[], createdAt: number) => ({
    checkpointId: id,
    createdAt,
    source: { orderedSurfaceSeqs: seqs },
  })

  it('orders by the highest shadowed sequence, newest first', () => {
    const older = bundle('a', [1, 2, 3], 1_000)
    const newer = bundle('b', [4, 5, 6], 2_000)
    expect(compareCheckpointRecencyDescending(older, newer)).toBeGreaterThan(0)
    expect(compareCheckpointRecencyDescending(newer, older)).toBeLessThan(0)
  })

  it('IGNORES createdAt when the sequences disagree with it', () => {
    // THE DEFECT. A clock that ran backwards, a retried publish, or two folds in
    // the same millisecond must not reorder history: the sequence span is the
    // authoritative record of where a checkpoint sits in the conversation.
    const chronologicallyNewer = bundle('newer', [50, 60], 1_000)
    const chronologicallyOlder = bundle('older', [10, 20], 9_999)
    expect(compareCheckpointRecencyDescending(chronologicallyOlder, chronologicallyNewer))
      .toBeGreaterThan(0)
  })

  it('falls back to createdAt only when a bundle has no sequences', () => {
    const noSeqsOld = bundle('a', [], 1_000)
    const noSeqsNew = bundle('b', [], 2_000)
    expect(compareCheckpointRecencyDescending(noSeqsOld, noSeqsNew)).toBeGreaterThan(0)
    // A bundle WITH sequences always outranks one without: an unsequenced
    // bundle cannot claim to be current.
    const sequenced = bundle('c', [1], 1)
    expect(compareCheckpointRecencyDescending(noSeqsNew, sequenced)).toBeGreaterThan(0)
  })

  it('breaks ties deterministically, so the same inputs give the same order', () => {
    const left = bundle('aaa', [7], 1_000)
    const right = bundle('bbb', [7], 1_000)
    // Antisymmetric and non-zero: a stable total order, not a coin flip.
    expect(compareCheckpointRecencyDescending(left, right)).toBeLessThan(0)
    expect(compareCheckpointRecencyDescending(right, left)).toBeGreaterThan(0)
    expect(compareCheckpointRecencyDescending(left, left)).toBe(0)
  })

  it('reports the source range as min and max of the shadowed sequences', () => {
    expect(sourceRangeOf({ source: { orderedSurfaceSeqs: [5, 9, 2] } }))
      .toEqual({ first: 2, last: 9 })
    expect(sourceRangeOf({ source: { orderedSurfaceSeqs: [] } })).toBeUndefined()
  })
})

describe('RC1.3.1: cross-checkpoint supersession survives the limit', () => {
  /**
   * C1 says 30, C2 says 60, C3 says 90 — the same fact at three points in time.
   *
   * Each checkpoint is a separate fold, so each is a separate archive. The
   * CURRENT value lives in the newest one, and that is what a search must
   * surface first.
   */
  async function threeVersions(): Promise<{ store: FoldBundleStore; sessionId: SessionIdType }> {
    const bundles = [
      bundleOf({
        checkpointId: 'c1', sessionId: SID, seqs: [1, 2], createdAt: 1_000,
        messages: [prose('The parser timeout is 30 seconds.')],
        renderedText: '[EF1 L cp:c1]',
      }),
      bundleOf({
        checkpointId: 'c2', sessionId: SID, seqs: [3, 4], createdAt: 2_000,
        messages: [prose('The parser timeout is 60 seconds.')],
        renderedText: '[EF1 L cp:c2]',
      }),
      bundleOf({
        checkpointId: 'c3', sessionId: SID, seqs: [5, 6], createdAt: 3_000,
        messages: [prose('CORRECTION: the parser timeout is 90 seconds.')],
        renderedText: '[EF1 L cp:c3]',
      }),
    ]
    return storeWith(bundles)
  }

  it('returns the NEWEST version first', async () => {
    const { store, sessionId } = await threeVersions()
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    expect(hits.map(hit => hit.checkpointId)).toEqual(['c3', 'c2', 'c1'])
    expect(hits[0]!.excerpt).toContain('90')
  })

  it('does NOT let a small limit hide the current value', async () => {
    // THE DEFECT, exactly. `list()` is ascending and `search` used to stop at
    // `limit`, so limit=2 returned C1 and C2 — the two SUPERSEDED values — and
    // dropped C3, the one that is current. A model asking "what is the timeout"
    // would be handed 30 and 60 and never shown 90.
    const { store, sessionId } = await threeVersions()
    const hits = await search({ store, sessionId, query: 'parser timeout', limit: 2 })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.checkpointId).toBe('c3')
    expect(hits[0]!.excerpt).toContain('90')
  })

  it('still makes the superseded versions reachable', async () => {
    // Newest-first must not mean newest-ONLY: the whole point of an archive is
    // that the value it superseded is still there.
    const { store, sessionId } = await threeVersions()
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    expect(hits.map(hit => hit.excerpt).join(' ')).toContain('30')
    expect(hits.map(hit => hit.excerpt).join(' ')).toContain('60')
  })

  it('orders by source chronology even when createdAt is inverted', async () => {
    // Same three checkpoints, timestamps reversed. Ordering must not change.
    const bundles = [
      bundleOf({
        checkpointId: 'old', sessionId: SID, seqs: [1, 2], createdAt: 9_000,
        messages: [prose('The parser timeout is 30 seconds.')], renderedText: '[EF1 L cp:old]',
      }),
      bundleOf({
        checkpointId: 'new', sessionId: SID, seqs: [9, 10], createdAt: 1_000,
        messages: [prose('The parser timeout is 90 seconds.')], renderedText: '[EF1 L cp:new]',
      }),
    ]
    const { store, sessionId } = await storeWith(bundles)
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    expect(hits.map(hit => hit.checkpointId)).toEqual(['new', 'old'])
  })
})

describe('RC1.3.1: same-checkpoint supersession reads the LATEST match', () => {
  /**
   * One checkpoint, two messages: the original value and the correction.
   *
   * This is the shape a single long turn produces, and the shape RC1.3's probe
   * never had.
   */
  async function twoVersionsInOneCheckpoint(): Promise<{ store: FoldBundleStore; sessionId: SessionIdType }> {
    const bundle = bundleOf({
      checkpointId: 'one', sessionId: SID, seqs: [1, 2, 3], createdAt: 1_000,
      renderedText: '[EF1 L cp:one]',
      messages: [
        prose('unrelated opening'),
        prose('The parser timeout is 30 seconds.'),
        prose('more unrelated work'),
        prose('CORRECTION: the parser timeout is now 90 seconds, superseding the 30.'),
      ],
    })
    return storeWith([bundle])
  }

  it('points at the NEWEST matching message, not the first', async () => {
    // THE DEFECT. `locate` returned the first match, so the hit pointed at the
    // superseded 30 and the excerpt showed it — the model would read the OLD
    // value as if it were the answer.
    const { store, sessionId } = await twoVersionsInOneCheckpoint()
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchedMessageIndex).toBe(3)
    expect(hits[0]!.excerpt).toContain('90')
  })

  it('reports how many messages matched, so the model knows history exists', async () => {
    const { store, sessionId } = await twoVersionsInOneCheckpoint()
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    expect(hits[0]!.matchCount).toBe(2)
    // And where the OLDEST one is, so the superseded value stays reachable
    // without paging the whole archive.
    expect(hits[0]!.earliestMatchedMessageIndex).toBe(1)
  })

  it('reports a single match as a count of one', async () => {
    const { store, sessionId } = await twoVersionsInOneCheckpoint()
    const hits = await search({ store, sessionId, query: 'unrelated opening' })
    expect(hits[0]!.matchCount).toBe(1)
    expect(hits[0]!.matchedMessageIndex).toBe(0)
    expect(hits[0]!.earliestMatchedMessageIndex).toBe(0)
  })

  it('prefers the archive match over the checkpoint text', async () => {
    // The archive is raw history and the checkpoint text is a DERIVED summary.
    // When both carry the query, the archive is the more actionable answer: it
    // is what recall returns verbatim, and it is where the chronology lives.
    const bundle = bundleOf({
      checkpointId: 'both', sessionId: SID, seqs: [1], createdAt: 1_000,
      renderedText: '[EF1 L cp:both] the parser timeout summary',
      messages: [prose('The parser timeout is 90 seconds.')],
    })
    const { store, sessionId } = await storeWith([bundle])
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    expect(hits[0]!.matchKind).toBe('message-text')
    expect(hits[0]!.matchedMessageIndex).toBe(0)
  })
})

describe('RC1.3.1: matchedMessageIndex is the recommended recall offset', () => {
  /** A checkpoint with 30 archived messages, the fact at index 23. */
  async function deepArchive(): Promise<{ store: FoldBundleStore; sessionId: SessionIdType }> {
    const messages = Array.from({ length: 30 }, (_, index) =>
      index === 23 ? prose('The batch size must never exceed 64 items.') : prose(`filler message ${index}`))
    const bundle = bundleOf({
      checkpointId: 'deep', sessionId: SID, seqs: [1], createdAt: 1_000,
      messages, renderedText: '[EF1 L cp:deep]',
    })
    return storeWith([bundle])
  }

  it('recalling at that offset returns a page that STARTS at the match', async () => {
    // THE DEFECT. `exactPageOffset` was page-aligned for the default page size,
    // so it was only ever "a page that contains the match" — and only for a
    // caller using that exact size. `matchedMessageIndex` is a valid offset for
    // ANY limit: the page begins at the match.
    const { store, sessionId } = await deepArchive()
    const hits = await search({ store, sessionId, query: 'batch size' })
    const index = hits[0]!.matchedMessageIndex!
    expect(index).toBe(23)

    const page = await recall({ store, sessionId, checkpointId: 'deep', depth: 'exact', offset: index })
    const first = page!.page!.messages[0]!
    const text = first.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('64 items')
  })

  it('works at a non-default page size, where a page-aligned offset would not', async () => {
    // The precise failure of the old field: with limit=5 the aligned offset 20
    // returns messages 20..24, which happens to include 23 — but with the match
    // at index 23 and limit=2, offset 20 returns 20..21 and MISSES it. An offset
    // equal to the match is correct at every size.
    const { store, sessionId } = await deepArchive()
    const page = await recall({ store, sessionId, checkpointId: 'deep', depth: 'exact', offset: 23, limit: 2 })
    const texts = page!.page!.messages.map(message =>
      message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    expect(texts[0]).toContain('64 items')
    expect(texts).toHaveLength(2)
  })

  it('the oldest match offset reaches the superseded value', async () => {
    const bundle = bundleOf({
      checkpointId: 'hist', sessionId: SID, seqs: [1], createdAt: 1_000,
      renderedText: '[EF1 L cp:hist]',
      messages: [
        prose('The parser timeout is 30 seconds.'),
        prose('filler'),
        prose('CORRECTION: the parser timeout is now 90 seconds.'),
      ],
    })
    const { store, sessionId } = await storeWith([bundle])
    const hits = await search({ store, sessionId, query: 'parser timeout' })
    const oldest = hits[0]!.earliestMatchedMessageIndex!
    const page = await recall({ store, sessionId, checkpointId: 'hist', depth: 'exact', offset: oldest })
    const text = page!.page!.messages[0]!.content
      .map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('30 seconds')
  })
})

describe('RC1.3.1: the guard holds on the real fold path', () => {
  it('a session that folds repeatedly reports its checkpoints newest-first', async () => {
    // The unit tests above use hand-built bundles so chronology can be
    // controlled. This one drives REAL folds, so the sequence numbers come from
    // the engine and the ordering claim is not an artifact of the fixture.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 6_000,
      plugin: true,
      systemPrompt: true,
      tools: true,
      efConfig: {
        thresholdRatio: 0.15,
        headroomTokens: 0,
        retainTokens: 700,
        maxTokens: 1_500,
      },
    })
    const session = Session.create(SessionId(`rc131-real-${Date.now()}`))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'test-model', model: 'test-model' } },
      reason: 'initial',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'The parser timeout is 30 seconds.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    for (let turn = 2; turn <= 15; turn += 1) {
      session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `filler ${turn} ${'payload '.repeat(60)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      try {
        await (harness.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded({ session, options: { provider: 'test-model', model: 'test-model' } }, 'pressure', SIGNAL)
      } catch { /* a refused fold is a decision */ }
    }

    const hits = await search({
      store: harness.engine.bundleStore,
      sessionId: session.id,
      query: 'parser timeout',
    })
    expect(hits.length).toBeGreaterThan(0)
    // Every hit must carry a source range, and the list must be ordered by it
    // descending — the invariant a model relies on to read the newest first.
    const ranges = hits.map(hit => hit.sourceRange)
    expect(ranges.every(range => range !== undefined)).toBe(true)
    const lasts = ranges.map(range => range!.last)
    expect([...lasts].sort((a, b) => b - a)).toEqual(lasts)
  }, 300_000)
})

describe('RC1.3.1: ordering is total and repeatable', () => {
  it('gives the same order on every call', async () => {
    // A model that re-queries must not get a different history. Two folds in the
    // same millisecond used to be ordered by filesystem readdir order.
    const bundles = [
      bundleOf({ checkpointId: 'x', sessionId: SID, seqs: [1], createdAt: 5_000,
        messages: [prose('the parser timeout is 10 seconds')], renderedText: '[EF1 L cp:x]' }),
      bundleOf({ checkpointId: 'y', sessionId: SID, seqs: [2], createdAt: 5_000,
        messages: [prose('the parser timeout is 20 seconds')], renderedText: '[EF1 L cp:y]' }),
      bundleOf({ checkpointId: 'z', sessionId: SID, seqs: [3], createdAt: 5_000,
        messages: [prose('the parser timeout is 30 seconds')], renderedText: '[EF1 L cp:z]' }),
    ]
    const { store, sessionId } = await storeWith(bundles)
    const first = await search({ store, sessionId, query: 'parser timeout' })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = await search({ store, sessionId, query: 'parser timeout' })
      expect(again.map((hit: SearchHit) => hit.checkpointId))
        .toEqual(first.map((hit: SearchHit) => hit.checkpointId))
    }
    // And the order follows the sequences, not the identical timestamps.
    expect(first.map(hit => hit.checkpointId)).toEqual(['z', 'y', 'x'])
  })

  it('a tool-name match inside an archive also reports its index', async () => {
    // The temporal guard must not only cover prose: a tool call is a message
    // too, and it needs the same offset affordance.
    const messages = [
      prose('opening'),
      createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool-call', id: ToolCallId('c1'), name: 'grep_registry', arguments: '{"pattern":"timeout"}' },
        ],
        source: { kind: 'model', provider: 'test-model', model: 'test-model' },
      }),
    ]
    const bundle = bundleOf({
      checkpointId: 'tools', sessionId: SID, seqs: [1], createdAt: 1_000,
      messages, renderedText: '[EF1 L cp:tools]',
    })
    const { store, sessionId } = await storeWith([bundle])
    const hits = await search({ store, sessionId, query: 'grep_registry' })
    expect(hits[0]!.matchKind).toBe('tool-name')
    expect(hits[0]!.matchedMessageIndex).toBe(1)
    expect(hits[0]!.excerpt).toContain('grep_registry')
  })

  it('an empty query still returns nothing', async () => {
    const { store, sessionId } = await storeWith([
      bundleOf({ checkpointId: 'q', sessionId: SID, seqs: [1], createdAt: 1_000,
        messages: [prose('anything')], renderedText: '[EF1 L cp:q]' }),
    ])
    expect(await search({ store, sessionId, query: '   ' })).toHaveLength(0)
  })
})

