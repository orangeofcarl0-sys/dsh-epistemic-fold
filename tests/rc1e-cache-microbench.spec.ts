/**
 * RC1-E: the cache microbench is a controlled experiment, not a longer soak.
 *
 * Three properties have to hold or the microbench reproduces the very confound
 * it exists to remove:
 *
 * 1. ABBA ordering — each arm must appear equally often first and second, or a
 *    systematic advantage from running second accumulates into one arm's mean.
 * 2. Independent namespaces — block *i* must not be able to hit block *i−1*'s
 *    cache, or "isolated self-cache" and "shared carryover" become the same
 *    measurement.
 * 3. The three structures must actually differ in what they expect, because a
 *    root mutation that looked like a stable append would report a cold shock
 *    as a defect.
 *
 * The classifier is tested against each of §24's four outcomes, including the
 * `unknown` one that keeps the default flip blocked.
 */

import { describe, expect, it } from 'vitest'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import {
  ABBA_TRIAL_ORDER,
  buildBlock,
  buildSchedule,
  classifyAgainstBaseline,
  classifyOutlier,
  namespaceToken,
  probesToMarkdown,
  realizedReuse,
  summarizeProbes,
} from '../eval/cache/microbench.ts'
import type { CacheProbeRequest, CacheProbeResult } from '../eval/cache/microbench.ts'

/** Synthesize a result for one request, for aggregation tests. */
function resultOf(
  request: CacheProbeRequest,
  options: { readonly reuse: number; readonly promptTokens?: number; readonly ok?: boolean },
): CacheProbeResult {
  const promptTokens = options.promptTokens ?? 6_000
  const cacheReadTokens = Math.round(promptTokens * options.reuse)
  return {
    block: request.block,
    structure: request.structure,
    arm: request.arm,
    index: request.index,
    expectsReuse: request.expectsReuse,
    promptTokens,
    cacheReadTokens,
    uncachedInputTokens: promptTokens - cacheReadTokens,
    outputTokens: 10,
    realizedReuse: realizedReuse(promptTokens, cacheReadTokens),
    ok: options.ok ?? true,
  }
}

describe('RC1-E: the schedule is counterbalanced and namespaced', () => {
  it('ABBA gives each arm equal first and second position', () => {
    // The confound RC1 §22 names: without this, whichever arm runs second
    // inherits the other's cache state and the difference is time, not policy.
    expect(ABBA_TRIAL_ORDER).toEqual([['E', 'B'], ['B', 'E'], ['B', 'E'], ['E', 'B']])
    const firsts = ABBA_TRIAL_ORDER.map(order => order[0])
    const seconds = ABBA_TRIAL_ORDER.map(order => order[1])
    expect(firsts.filter(arm => arm === 'E').length).toBe(2)
    expect(firsts.filter(arm => arm === 'B').length).toBe(2)
    expect(seconds.filter(arm => arm === 'E').length).toBe(2)
    expect(seconds.filter(arm => arm === 'B').length).toBe(2)
    // And every trial runs BOTH arms, so a trial yields a paired comparison
    // rather than a single arm's reading.
    for (const order of ABBA_TRIAL_ORDER) expect(new Set(order).size).toBe(2)
  })

  it('every BLOCK gets its own namespace, distinct from every other block', () => {
    // Requests WITHIN one arm's block deliberately share a prefix — that is what
    // makes the block's later requests warm naturally. Distinctness is required
    // BETWEEN blocks, which is what stops block i from hitting block i−1.
    const schedule = buildSchedule({ structures: ['stable-append'], isolated: true })
    const namespacesOfBlock = new Map<string, Set<string>>()
    for (const request of schedule) {
      const token = request.prefix.split('\n')[0]!
      expect(token).toContain('CACHE-BLOCK-')
      const set = namespacesOfBlock.get(request.block) ?? new Set<string>()
      set.add(token)
      namespacesOfBlock.set(request.block, set)
    }
    // Four ABBA trials. In isolated mode each trial carries one namespace PER
    // ARM, so an arm can only ever hit its own cache.
    expect(namespacesOfBlock.size).toBe(4)
    for (const set of namespacesOfBlock.values()) expect(set.size).toBe(2)
    // No namespace is reused across blocks.
    const all = [...namespacesOfBlock.values()].flatMap(set => [...set])
    expect(new Set(all).size).toBe(all.length)
  })

  it('isolated mode separates the arms; shared mode does not', () => {
    // The two modes answer two different questions and must not be conflated:
    // isolated = "each arm eats only its own cache", shared = "the real
    // cross-run carryover a deployment sees".
    expect(namespaceToken(1, 'E', true)).not.toBe(namespaceToken(1, 'B', true))
    expect(namespaceToken(1, 'E', false)).toBe(namespaceToken(1, 'B', false))
    const isolated = buildSchedule({ structures: ['stable-append'], isolated: true })
    const shared = buildSchedule({ structures: ['stable-append'], isolated: false })
    const isolatedTokens = new Set(isolated.map(request => request.prefix.split('\n')[0]!))
    const sharedTokens = new Set(shared.map(request => request.prefix.split('\n')[0]!))
    // Twice as many distinct prefixes when the arms are separated.
    expect(isolatedTokens.size).toBe(sharedTokens.size * 2)
  })

  it('the three structures differ in what they expect, as §21 requires', () => {
    const at = (structure: 'stable-append' | 'leaf-append' | 'root-mutation') =>
      buildBlock({ block: 0, structure, arm: 'E', prefixTokens: 6_000, suffixTokens: 400, isolated: true })

    const stable = at('stable-append')
    const leaf = at('leaf-append')
    const root = at('root-mutation')

    // A stable append reuses everything after the first request.
    expect(stable.map(request => request.expectsReuse)).toEqual([false, true, true])
    // A leaf fold rewrites the TAIL but must keep the prefix, so it also
    // expects reuse — that is the property R3's framing change relies on.
    expect(leaf.map(request => request.expectsReuse)).toEqual([false, true, true])
    // A root REWRITES the prefix, so its second request is a deliberate cold
    // shock. Marking it as reuse-expected would report a design consequence as
    // a defect.
    expect(root.map(request => request.expectsReuse)).toEqual([false, false, true])
    // And the root's prefix genuinely differs between its two requests.
    expect(root[0]!.prefix).not.toBe(root[1]!.prefix)
    // While the leaf's does not.
    expect(leaf[0]!.prefix).toBe(leaf[1]!.prefix)
  })

  it('a leaf checkpoint is present in the second leaf request', () => {
    const leaf = buildBlock({ block: 0, structure: 'leaf-append', arm: 'E', prefixTokens: 6_000, suffixTokens: 400, isolated: true })
    expect(leaf[1]!.messages.some(message => message.text.includes('[EF1 L cp:'))).toBe(true)
    expect(leaf[1]!.messages.some(message => message.text.includes('post-fold-fresh'))).toBe(true)
  })
})

describe('RC1-E: aggregation compares like with like', () => {
  it('computes the E/B reuse ratio and flags incomparable prompt sizes', () => {
    const schedule = buildSchedule({ structures: ['stable-append'], prefixTokens: 6_000, suffixTokens: 400 })
    // EF reuses 0.9, Basic reuses 0.95 at the same prompt size.
    const results = schedule.map(request =>
      resultOf(request, { reuse: request.arm === 'E' ? 0.9 : 0.95, promptTokens: 6_000 }))
    const [summary] = summarizeProbes(results)
    expect(summary).toBeDefined()
    expect(summary!.promptSizeComparable).toBe(true)
    expect(summary!.reuseRatio).toBeCloseTo(0.9 / 0.95, 5)

    // Now make EF's prompt 20% larger: the ratio must no longer be presented as
    // a like-for-like cache comparison.
    const skewed = schedule.map(request =>
      resultOf(request, {
        reuse: request.arm === 'E' ? 0.9 : 0.95,
        promptTokens: request.arm === 'E' ? 7_200 : 6_000,
      }))
    const [skewedSummary] = summarizeProbes(skewed)
    expect(skewedSummary!.promptSizeComparable).toBe(false)
  })

  it('separates cold-shock requests from reuse-expected ones', () => {
    // A root mutation's cold shock must be measured, not averaged into the
    // reuse figure where it would look like a policy defect.
    const schedule = buildSchedule({ structures: ['root-mutation'], prefixTokens: 6_000, suffixTokens: 400 })
    const results = schedule.map(request =>
      resultOf(request, { reuse: request.expectsReuse ? 0.9 : 0.05 }))
    const [summary] = summarizeProbes(results)
    expect(summary!.arms[0]!.meanReuseWhenExpected).toBeCloseTo(0.9, 5)
    expect(summary!.arms[0]!.meanReuseWhenCold).toBeCloseTo(0.05, 5)
    // The two are reported separately, which is the point.
    expect(summary!.arms[0]!.meanReuseWhenExpected).not.toBe(summary!.arms[0]!.meanReuseWhenCold)
  })

  it('never reports an absent measurement as zero reuse', () => {
    expect(realizedReuse(0, 0)).toBeUndefined()
    expect(realizedReuse(1_000, 0)).toBe(0)
    expect(realizedReuse(1_000, 500)).toBe(0.5)
  })

  it('renders a readable table', () => {
    const schedule = buildSchedule({ structures: ['stable-append', 'leaf-append'] })
    const results = schedule.map(request => resultOf(request, { reuse: 0.8 }))
    const markdown = probesToMarkdown(summarizeProbes(results))
    expect(markdown).toContain('| Structure | Arm |')
    expect(markdown).toContain('E/B reuse ratio')
  })
})

describe('RC1-E: an outlier is classified, never dropped', () => {
  it('attributes a failure to availability FIRST', () => {
    // §24's ordering matters: a retry changes the cost for a reason unrelated
    // to caching, so checking cache state first would misattribute it.
    const classification = classifyOutlier({
      ratio: 2.265,
      meanPromptTokensE: 6_000,
      meanPromptTokensB: 6_050,
      failedRequests: 1,
      meanReuseE: 0.1,
      meanReuseB: 0.9,
    })
    expect(classification.cause).toBe('availability')
  })

  it('attributes a structurally larger EF prompt to policy', () => {
    const classification = classifyOutlier({
      ratio: 2.265,
      meanPromptTokensE: 12_000,
      meanPromptTokensB: 6_000,
      failedRequests: 0,
      meanReuseE: 0.9,
      meanReuseB: 0.9,
    })
    expect(classification.cause).toBe('policy')
    expect(classification.evidence.join(' ')).toContain('structurally larger')
  })

  it('attributes a cache deficit at COMPARABLE shape to provider cache state', () => {
    // The RC0-C signature: same prompts, same call counts, EF read less cache.
    const classification = classifyOutlier({
      ratio: 2.265,
      meanPromptTokensE: 6_000,
      meanPromptTokensB: 6_050,
      failedRequests: 0,
      meanReuseE: 0.1,
      meanReuseB: 0.9,
    })
    expect(classification.cause).toBe('provider-cache-state')
    expect(classification.evidence.join(' ')).toContain('provider cache-state')
  })

  it('returns UNKNOWN when nothing explains it, which keeps the flip blocked', () => {
    const classification = classifyOutlier({
      ratio: 2.265,
      meanPromptTokensE: 6_000,
      meanPromptTokensB: 6_050,
      failedRequests: 0,
      meanReuseE: 0.9,
      meanReuseB: 0.9,
    })
    expect(classification.cause).toBe('unknown')
  })

  it('keeps the observed ratio and its evidence in every classification', () => {
    // §26: the outlier is never silently dropped. Whatever it is attributed to,
    // the number and the reasoning travel with it.
    for (const options of [
      { ratio: 2.265, meanPromptTokensE: 6_000, meanPromptTokensB: 6_000, failedRequests: 1, meanReuseE: 0.1, meanReuseB: 0.9 },
      { ratio: 2.265, meanPromptTokensE: 12_000, meanPromptTokensB: 6_000, failedRequests: 0, meanReuseE: 0.9, meanReuseB: 0.9 },
      { ratio: 2.265, meanPromptTokensE: 6_000, meanPromptTokensB: 6_000, failedRequests: 0, meanReuseE: 0.1, meanReuseB: 0.9 },
      { ratio: 2.265, meanPromptTokensE: 6_000, meanPromptTokensB: 6_000, failedRequests: 0, meanReuseE: 0.9, meanReuseB: 0.9 },
    ]) {
      const classification = classifyOutlier(options)
      expect(classification.ratio).toBe(2.265)
      expect(classification.evidence.length).toBeGreaterThan(0)
    }
  })
})

describe('RC1-E: the live adapter actually SENDS the system prompt', () => {
  it('places the system prompt as a system-role message, not a top-level field', async () => {
    // Found while running the live microbench, and it invalidated the first
    // run: this endpoint accepts a top-level `system` field, returns HTTP 200,
    // and SILENTLY IGNORES IT. A 240,003-character system prompt billed 13
    // prompt tokens — the size of the user message alone.
    //
    // The consequence was not cosmetic. The R3 framing change earns its entire
    // saving by moving the checkpoint preamble INTO the system prompt, so any
    // live measurement made through a request that carried no system prompt was
    // measuring the saving of a change that never reached the model. This test
    // pins the wire shape with a stub fetch, so the defect cannot recur without
    // spending money to rediscover it.
    const captured: Record<string, unknown>[] = []
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        captured.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          text: async () => '',
        }
      }) as unknown as typeof fetch,
    })

    for await (const chunk of adapter.stream({
      provider: 'live',
      model: 'live',
      system: 'STABLE PREFIX TEXT',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
      maxTokens: 4,
    } as never)) {
      void chunk
    }

    expect(captured).toHaveLength(1)
    const body = captured[0]!
    // The defect: a top-level `system` field that the endpoint discards.
    expect(body.system).toBeUndefined()
    // The fix: a system-ROLE message, which is what the endpoint prices.
    const messages = body.messages as readonly { role: string; content: unknown }[]
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toBe('STABLE PREFIX TEXT')
    expect(messages[1]!.role).toBe('user')
  })

  it('omits the system message entirely when there is no system prompt', async () => {
    // A request with no system prompt must not gain an empty one, which would
    // change the prefix and therefore the cache key.
    const captured: Record<string, unknown>[] = []
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        captured.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          text: async () => '',
        }
      }) as unknown as typeof fetch,
    })
    for await (const chunk of adapter.stream({
      provider: 'live',
      model: 'live',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
      maxTokens: 4,
    } as never)) {
      void chunk
    }
    const messages = captured[0]!.messages as readonly { role: string }[]
    expect(messages.some(message => message.role === 'system')).toBe(false)
    expect(messages).toHaveLength(1)
  })
})

describe('RC1-E: the baseline classifier attributes the RC0 outlier', () => {
  it('attributes 2.265 to provider cache state when the shapes cache identically', () => {
    // The measured result: ABBA-counterbalanced probes at identical prompt
    // sizes show E/B reuse 1.000. A paired run's 2.265 therefore cannot be a
    // property of the request shapes — there is no structural difference for it
    // to be. RC1 §42 asks for exactly this classification.
    const classification = classifyAgainstBaseline({
      ratio: 2.265,
      baselineReuseRatio: 1.0,
      baselineComparable: true,
      failedRequests: 0,
    })
    expect(classification.cause).toBe('provider-cache-state')
    expect(classification.evidence.join(' ')).toContain('external to the policy')
  })

  it('attributes it to POLICY when the baseline itself shows a deficit', () => {
    // The honest complement: a baseline below 1 means the shapes DO cost
    // reuse, and then the ratio IS structural. A classifier that answered
    // "provider" regardless would be a rubber stamp, not a measurement.
    const classification = classifyAgainstBaseline({
      ratio: 2.265,
      baselineReuseRatio: 0.8,
      baselineComparable: true,
      failedRequests: 0,
    })
    expect(classification.cause).toBe('policy')
    expect(classification.evidence.join(' ')).toContain('attributable to the request shapes')
  })

  it('stays UNKNOWN when the baseline is missing or incomparable', () => {
    expect(classifyAgainstBaseline({
      ratio: 2.265, baselineReuseRatio: undefined, baselineComparable: true, failedRequests: 0,
    }).cause).toBe('unknown')
    expect(classifyAgainstBaseline({
      ratio: 2.265, baselineReuseRatio: 1.0, baselineComparable: false, failedRequests: 0,
    }).cause).toBe('unknown')
  })

  it('attributes to availability before anything else', () => {
    const classification = classifyAgainstBaseline({
      ratio: 2.265, baselineReuseRatio: 1.0, baselineComparable: true, failedRequests: 2,
    })
    expect(classification.cause).toBe('availability')
  })
})
