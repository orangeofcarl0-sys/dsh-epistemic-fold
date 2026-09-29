/**
 * RC1.3: the search hit explains itself, and the failure taxonomy names the link.
 *
 * Two keyless suites, both pinning things the live tier then relies on:
 *
 *  - `search` reports WHERE a query matched (summary vs archive), a bounded
 *    verbatim excerpt, and the `context_recall` page that holds the match. This
 *    is what lets a model go from "something matched" to a targeted recall
 *    instead of paging an archive blind.
 *
 *  - the taxonomy labels a run by the FIRST link of the retrieval chain that
 *    failed, so a live result is diagnosable rather than just a score.
 *
 * @module tests/rc13-retrieval-ergonomics
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createHarness, extractCheckpointId, foldAgent, lastCompactionSummary, SIGNAL } from './harness.ts'
import { FACTS, FACT_PROBES } from './recall-loop.ts'
import {
  excerptAround,
  recall,
  SEARCH_EXCERPT_CHARS,
  SEARCH_WHOLE_MESSAGE_CHARS,
  search,
} from '../src/recall.ts'
import {
  classifyFact,
  classifyRun,
  FAILURE_ORDER,
  recommendedAction,
  summarizeTaxonomy,
} from '../eval/src/retrieval-taxonomy.ts'
import type { FactTrace, RetrievalFailure, RunVerdict, TaxonomySummary } from '../eval/src/retrieval-taxonomy.ts'

function summaryText(blocks: readonly unknown[]): string {
  return (blocks as readonly ContentBlock[]).map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** A conversation whose early prose carries a distinctive fact. */
function factFixture(fact: string, fillerTurns: number): Session {
  const session = Session.create(SessionId(`rc13-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: 'test-model', model: 'test-model' } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Background note. ${fact} Please remember it.` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  // The LAST turn is left OPEN, mirroring the harness's own fixtures: the manual
  // `compactRegion` path requires an enclosing turn, and a fixture that closed
  // every turn would exercise the engine's error path instead of search.
  for (let turn = 2; turn <= fillerTurns + 1; turn += 1) {
    session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `filler ${turn} ${'payload '.repeat(30)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  return session
}

describe('RC1.3: a search hit says where it matched', () => {
  it('reports an archive match with an excerpt and the recall page that holds it', async () => {
    const FACT = 'The failing error code we are chasing is PARSE-7741.'
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = factFixture(FACT, 3)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(
      nodes[0]!, nodes[nodes.length - 1]!,
      foldAgent(session),
      SIGNAL,
    )

    const hits = await search({ store, sessionId: session.id, query: 'PARSE-7741' })
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits[0]!

    // The fact was folded into the ARCHIVE, not into the checkpoint summary
    // (the digest fixture does not echo the message text), so the hit must say
    // so — that distinction is what tells the model a recall is required.
    expect(hit.matchKind).toBe('message-text')
    expect(hit.matchedMessageIndex).toBeTypeOf('number')
    expect(hit.archiveMessages).toBeGreaterThan(0)
    // The excerpt is the actionable part: the model can see the fact is there.
    expect(hit.excerpt).toContain('PARSE-7741')
    expect(hit.excerpt!.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS + 2)
    // RC1.3.1: `matchedMessageIndex` IS the recall offset, and it is a valid
    // offset for any page size — unlike the page-aligned `exactPageOffset` it
    // replaced, which was only "a page containing the match" for the default
    // page size. A page fetched at this offset BEGINS at the match.
    expect(hit.matchedMessageIndex).toBeTypeOf('number')
    const page = await recall({
      store, sessionId: session.id, checkpointId: hit.checkpointId,
      depth: 'exact', offset: hit.matchedMessageIndex!,
    })
    const first = page!.page!.messages[0]!
    const text = first.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('PARSE-7741')
  }, 300_000)

  it('a hit on ONE fact does not hide the message\'s OTHER facts', async () => {
    // THE LIVE DEFECT, pinned end to end. All three facts live in one message.
    // The model searched for the error code; the excerpt must not drop the
    // batch-size fact off the front, or the model answers it "unknown" and the
    // run is scored `search-miss` — a failure caused by the return shape rather
    // than by retrieval.
    const message = `Some context before we start. ${FACTS.constraint} ${FACTS.superseded} `
      + `${FACTS.supersession} ${FACTS.exact} Please keep all of this in mind.`
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = Session.create(SessionId(`rc13-sibling-${Date.now()}`))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'test-model', model: 'test-model' } },
      reason: 'initial',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: message }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    for (let turn = 2; turn <= 4; turn += 1) {
      session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `filler ${turn} ${'payload '.repeat(40)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)

    // Query for the LAST fact in the message, which is the case that used to
    // truncate the first one off the front.
    const hits = await search({ store, sessionId: session.id, query: 'error code' })
    expect(hits.length).toBeGreaterThan(0)
    const excerpt = hits[0]!.excerpt!
    for (const probe of FACT_PROBES) {
      expect(
        probe.present(excerpt),
        `searching for one fact must not hide the ${probe.id} fact from the hit`,
      ).toBe(true)
    }
  }, 300_000)

  it('reports a checkpoint-text match as needing no recall', async () => {
    // The digest text lands IN the checkpoint, so the fact is already on the
    // surface. A hit must distinguish this from an archive match: recall would
    // be wasted work here.
    const { engine, store } = await createHarness({ text: 'the parser module work' })
    const session = factFixture('Something unrelated entirely.', 3)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(
      nodes[0]!, nodes[nodes.length - 1]!,
      foldAgent(session),
      SIGNAL,
    )

    const hits = await search({ store, sessionId: session.id, query: 'parser module' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.matchKind).toBe('checkpoint-text')
    expect(hits[0]!.excerpt).toContain('parser module')
    // No archive location, so no message offset to point at.
    expect(hits[0]!.matchedMessageIndex).toBeUndefined()
    expect(hits[0]!.earliestMatchedMessageIndex).toBeUndefined()
    expect(hits[0]!.matchCount).toBe(1)
  }, 300_000)

  it('reports a tool-name match with the tool in the excerpt', async () => {
    // A REAL tool call, so the `tool-name` face is genuinely exercised rather
    // than inferred. `grep_registry` is distinctive enough that nothing else in
    // the fixture can produce the hit.
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = Session.create(SessionId(`rc13-tool-${Date.now()}`))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'test-model', model: 'test-model' } },
      reason: 'initial',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'please inspect the registry' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking the registry' },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'grep_registry', arguments: '{"pattern":"timeout"}' },
        ],
        source: { kind: 'model', provider: 'test-model', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'grep_registry', arguments: '{"pattern":"timeout"}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'no matches' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    // Filler turns: Basic refuses a fold whose summary is not smaller than the
    // shadowed region, so a fixture this short would test that guard rather
    // than search.
    for (let turn = 2; turn <= 4; turn += 1) {
      session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `filler ${turn} ${'payload '.repeat(40)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }

    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)

    const hits = await search({ store, sessionId: session.id, query: 'grep_registry' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.matchKind).toBe('tool-name')
    expect(hits[0]!.excerpt).toContain('grep_registry')
    // The argument preview travels with it, so the model can see WHAT was
    // searched for rather than only which tool ran.
    expect(hits[0]!.excerpt).toContain('timeout')
    expect(hits[0]!.matchedMessageIndex).toBeTypeOf('number')
  }, 300_000)

  it('an id query matches by identity alone', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = factFixture('unrelated', 2)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)
    const checkpointId = extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary))!

    const hits = await search({ store, sessionId: session.id, query: checkpointId })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchKind).toBe('id')
    expect(hits[0]!.matchedMessageIndex).toBeUndefined()
    expect(hits[0]!.matchCount).toBe(1)
  }, 300_000)
})

describe('RC1.3: the excerpt is bounded and marked when truncated', () => {
  it('returns a short message WHOLE, so no sibling fact is cut off', () => {
    // THE DEFECT THIS PINS, found by the live run: a 230-character message was
    // windowed to 240 characters around the match, which cut the message's
    // OTHER facts off the front. A model that searched for the error code got an
    // excerpt naming the timeout but not the batch limit, and answered the
    // batch-size question "unknown" — a `search-miss` manufactured by the
    // excerpt itself. A message this short must come back whole.
    const message = 'Some context. Our batch size must never exceed 64 items. '
      + 'The parser timeout was 30 seconds. CORRECTION: the parser timeout is now 90 seconds, '
      + 'superseding the 30. The failing error code we are chasing is PARSE-7741.'
    expect(message.length).toBeLessThan(SEARCH_WHOLE_MESSAGE_CHARS)
    const excerpt = excerptAround(message, 'error code')
    expect(excerpt).toBe(message)
    // Every fact the message carries survives, not only the matched one.
    expect(excerpt).toContain('64 items')
    expect(excerpt).toContain('90 seconds')
    expect(excerpt).toContain('PARSE-7741')
  })

  it('windows a long message around the match, marking both cuts', () => {
    const text = `${'a'.repeat(900)}NEEDLE${'b'.repeat(900)}`
    const excerpt = excerptAround(text, 'NEEDLE')
    expect(excerpt).toContain('NEEDLE')
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS + 2)
  })

  it('does not mark an excerpt that is the whole text', () => {
    expect(excerptAround('short NEEDLE here', 'NEEDLE')).toBe('short NEEDLE here')
  })

  it('is case-insensitive, matching search itself', () => {
    expect(excerptAround('the PARSE-7741 code', 'parse-7741')).toContain('PARSE-7741')
  })

  it('falls back to a marked prefix when the needle is absent', () => {
    // Defensive: `locate` only calls this on a match, but a caller passing a
    // non-matching needle must still get bounded, clearly-truncated text rather
    // than a whole long message.
    const excerpt = excerptAround('x'.repeat(2000), 'absent')
    expect(excerpt.length).toBe(SEARCH_EXCERPT_CHARS + 1)
    expect(excerpt.endsWith('…')).toBe(true)
  })
})

/** Build a trace from the fields the classifier reads. */
function trace(overrides: Partial<FactTrace> = {}): FactTrace {
  return {
    answerCarries: false,
    searched: false,
    searchHitRelevant: false,
    recalled: false,
    recallRelevant: false,
    ...overrides,
  }
}

/** One run whose single fact `a` has the given trace. */
function runOf(overrides: Partial<FactTrace> = {}): RunVerdict {
  return classifyRun(new Map<string, FactTrace>([['a', trace(overrides)]]))
}

describe('RC1.3: the taxonomy names the FIRST link that failed', () => {
  it('passes a fact the answer carried', () => {
    expect(classifyFact(trace({ answerCarries: true }))).toBe('pass')
  })

  it('labels a run that never attempted retrieval', () => {
    expect(classifyFact(trace())).toBe('no-search')
  })

  it('labels a search that returned nothing relevant', () => {
    expect(classifyFact(trace({ searched: true }))).toBe('search-miss')
  })

  it('labels a relevant hit the model did not open', () => {
    expect(classifyFact(trace({ searched: true, searchHitRelevant: true })))
      .toBe('search-hit-no-recall')
  })

  it('labels a recall that returned nothing relevant', () => {
    // The model went as deep as it could and NEITHER tool produced the fact.
    // This is the only EF-side candidate, so it must be its own label.
    expect(classifyFact(trace({ searched: true, recalled: true }))).toBe('recall-miss')
  })

  it('labels a recall-only attempt that came back empty as a recall miss', () => {
    // A model can recall without searching when a surface marker gave it the
    // id. That path must not be reported as `no-search`.
    expect(classifyFact(trace({ recalled: true }))).toBe('recall-miss')
  })

  it('labels a fact that was returned and then not used', () => {
    expect(classifyFact(trace({ searched: true, recalled: true, recallRelevant: true })))
      .toBe('recall-returned-fact-but-answer-missed')
  })

  it('treats a search excerpt that carried the fact as returned', () => {
    // The excerpt IS available to the model, so the fact was not lost in
    // retrieval. Calling this a recall miss would blame EF for a synthesis
    // failure — the exact misattribution this taxonomy exists to prevent.
    expect(classifyFact(trace({ searched: true, searchHitRelevant: true, recalled: true })))
      .toBe('recall-returned-fact-but-answer-missed')
  })

  it('reads the FIRST failure, not the worst-sounding one', () => {
    // Nothing was attempted, so no later field can be meaningful. A trace that
    // claims otherwise must still classify at the break.
    expect(classifyFact(trace({ searchHitRelevant: true }))).toBe('no-search')
  })
})

describe('RC1.3: run aggregation cannot hide an EF-side failure', () => {
  it('picks the EF-side failure as primary when one fact has it', () => {
    const verdict = classifyRun(new Map<string, FactTrace>([
      ['constraint', trace({ answerCarries: true })],
      // Two model-side failures and ONE recall-miss: the recall-miss outranks
      // them, because it is the only one that would be a product defect.
      ['timeout', trace({ searched: true })],
      ['code', trace({ searched: true, recalled: true })],
    ]))
    expect(verdict.primary).toBe('recall-miss')
    expect(verdict.score).toBe(1)
    expect(verdict.total).toBe(3)
  })

  it('reports pass when every fact was answered', () => {
    const verdict = classifyRun(new Map<string, FactTrace>([
      ['a', trace({ answerCarries: true })],
      ['b', trace({ answerCarries: true })],
    ]))
    expect(verdict.primary).toBe('pass')
    expect(verdict.score).toBe(2)
  })

  it('orders failures EF-side first', () => {
    expect(FAILURE_ORDER.indexOf('recall-miss'))
      .toBeLessThan(FAILURE_ORDER.indexOf('no-search'))
    expect(FAILURE_ORDER[FAILURE_ORDER.length - 1]).toBe('pass')
  })

  it('tallies runs and facts separately', () => {
    const summary = summarizeTaxonomy([
      runOf(),
      runOf({ searched: true }),
      runOf({ answerCarries: true }),
    ])
    expect(summary.runs).toBe(3)
    expect(summary.byPrimary['no-search']).toBe(1)
    expect(summary.byPrimary['search-miss']).toBe(1)
    expect(summary.byPrimary.pass).toBe(1)
    expect(summary.meanScore).toBeCloseTo(1 / 3, 5)
  })
})

describe('RC1.3: the taxonomy names the one change to make', () => {
  /** Runs whose forced primary label exercises the remedy mapping directly. */
  const withPrimary = (primary: RetrievalFailure, runs = 3): TaxonomySummary =>
    summarizeTaxonomy(
      Array.from({ length: runs }, (_, index) =>
        ({ ...runOf(index === 0 ? {} : { answerCarries: true }), primary })),
    )

  it('says "freeze" when nothing failed', () => {
    expect(recommendedAction(summarizeTaxonomy([runOf({ answerCarries: true })])).action)
      .toContain('freeze')
  })

  it('prioritizes a recall miss over any model-side label', () => {
    // Even a single recall-miss among many no-searches must dominate: it is the
    // only label that implicates the product.
    const summary = summarizeTaxonomy([
      runOf({ searched: true, recalled: true }),
      runOf(),
      runOf(),
      runOf(),
    ])
    expect(summary.byFact['recall-miss']).toBe(1)
    expect(recommendedAction(summary).action).toContain('recall coverage')
  })

  it('recommends the instruction only when no-search dominates', () => {
    const majority = withPrimary('no-search', 4)
    expect(recommendedAction(majority).action).toContain('instruction')
  })

  it('recommends the hit shape when the model searched and missed', () => {
    expect(recommendedAction(withPrimary('search-miss')).action).toContain('search return shape')
  })

  it('recommends nothing for a synthesis-only residual', () => {
    expect(recommendedAction(withPrimary('recall-returned-fact-but-answer-missed')).action)
      .toContain('do not change retrieval')
  })
})
