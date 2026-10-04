/**
 * RC1-E live: the cache microbench, run against the real provider.
 *
 * This is one of only two places RC1 spends money (§2, §31). It is small on
 * purpose: 4K–8K of stable prefix and a few hundred tokens of suffix, three
 * structures, ABBA counterbalanced — a few dozen requests, versus the
 * 24-turn × 3-workload × 5-replicate soak the earlier stages ran.
 *
 * The question it answers is RC1 §42's: the `2.265` outlier from RC0-C must be
 * classified as provider cache state, policy, availability, or unknown, and the
 * default flip stays blocked while it is unknown.
 *
 * The measurement is deliberately shaped so a classification is possible:
 *
 *   - `promptSizeComparable` says whether the two arms' requests were the same
 *     SIZE. Without it, a ratio difference could be shape rather than cache.
 *   - `meanReuseWhenCold` vs `meanReuseWhenExpected` separates a root's
 *     deliberate cold shock from a cache failure.
 *   - failures are recorded per request, so an availability cause is detectable
 *     rather than inferred.
 *
 * Opt-in: set `EF_LIVE=1`.
 *
 * @module tests/rc1e-live-cache
 */

import { describe, expect, it } from 'vitest'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import {
  buildSchedule,
  classifyAgainstBaseline,
  classifyOutlier,
  probesToMarkdown,
  realizedReuse,
  summarizeProbes,
} from '../eval/cache/microbench.ts'
import type { CacheProbeRequest, CacheProbeResult } from '../eval/cache/microbench.ts'
import { LIVE_ENABLED, LIVE_PROVIDER } from './live-gate.ts'

const PREFIX_TOKENS = Number(process.env.EF_LIVE_CACHE_PREFIX ?? 6_000)
const SUFFIX_TOKENS = Number(process.env.EF_LIVE_CACHE_SUFFIX ?? 400)

/** Issue one probe through the real adapter and record what the provider said. */
async function issue(
  adapter: OpenAiCompatibleAdapter,
  request: CacheProbeRequest,
): Promise<CacheProbeResult> {
  let promptTokens = 0
  let cacheReadTokens = 0
  let uncachedInputTokens = 0
  let outputTokens = 0
  let ok = false
  let failure: string | undefined

  for await (const chunk of adapter.stream({
    provider: LIVE_PROVIDER,
    model: 'live',
    system: request.prefix,
    messages: request.messages.map(message => ({
      role: message.role,
      content: [{ type: 'text' as const, text: message.text }],
      source: { kind: message.role === 'user' ? 'user' as const : 'model' as const },
    })),
    maxTokens: 8,
  } as never)) {
    if (chunk.type === 'usage') {
      uncachedInputTokens = chunk.usage.inputTokens ?? 0
      cacheReadTokens = chunk.usage.cacheReadTokens ?? 0
      outputTokens = chunk.usage.outputTokens ?? 0
      promptTokens = uncachedInputTokens + cacheReadTokens
      ok = true
    }
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      failure = chunk.reason.failure.message
    }
  }

  return {
    block: request.block,
    structure: request.structure,
    arm: request.arm,
    index: request.index,
    expectsReuse: request.expectsReuse,
    promptTokens,
    cacheReadTokens,
    uncachedInputTokens,
    outputTokens,
    realizedReuse: realizedReuse(promptTokens, cacheReadTokens),
    ok,
    ...(failure === undefined ? {} : { failure }),
  }
}

describe.runIf(LIVE_ENABLED)('RC1-E live: cache crossover, ABBA counterbalanced', () => {
  it('measures reuse per structure and classifies the RC0 outlier', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved; set EF_LIVE_API_KEY or configure ZCode').toBeDefined()
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl,
      apiKey: route!.apiKey,
      model: route!.model,
      contextWindow: 131_072,
    })

    // Two passes: ISOLATED (each arm can only hit its own cache) and SHARED
    // (both arms share a namespace, modelling real cross-run carryover). §23
    // requires both, reported separately — they answer different questions.
    const results: CacheProbeResult[] = []
    for (const isolated of [true, false]) {
      const schedule = buildSchedule({
        prefixTokens: PREFIX_TOKENS,
        suffixTokens: SUFFIX_TOKENS,
        isolated,
      })
      console.log(
        `CACHE (${isolated ? 'isolated' : 'shared'}): issuing ${schedule.length} probe request(s)`,
      )
      for (const request of schedule) {
        results.push(await issue(adapter, request))
      }
    }

    const summaries = summarizeProbes(results)
    console.log(probesToMarkdown(summaries))

    // The measurement must not be vacuous: if the provider reported no prompt
    // tokens for any request, nothing was priced and no conclusion is possible.
    const priced = results.filter(result => result.promptTokens > 0)
    console.log(`CACHE: ${priced.length}/${results.length} request(s) reported usage`)
    expect(priced.length).toBeGreaterThan(0)

    // THE GUARD THAT WOULD HAVE CAUGHT THE ADAPTER DEFECT. A top-level `system`
    // field is accepted with HTTP 200 and silently ignored by this endpoint, so
    // a probe whose system prompt never arrived reports a prompt the size of its
    // user message alone. The prefix is ~PREFIX_TOKENS tokens; if the reported
    // prompt is a small fraction of that, the prefix did not reach the model and
    // every reuse number below is about the suffix.
    const meanPrompt = priced.reduce((sum, result) => sum + result.promptTokens, 0) / priced.length
    console.log(`CACHE: mean reported prompt ${meanPrompt.toFixed(0)} tokens for a ~${PREFIX_TOKENS}-token prefix`)
    expect(
      meanPrompt,
      `the reported prompt (${meanPrompt.toFixed(0)}) is far below the ~${PREFIX_TOKENS}-token prefix, `
      + 'which means the system prompt did not reach the provider',
    ).toBeGreaterThan(PREFIX_TOKENS * 0.5)

    const failures = results.filter(result => !result.ok)
    if (failures.length > 0) {
      console.log(`CACHE: ${failures.length} failed request(s): ${failures.map(f => f.failure).join('; ')}`)
    }

    // Classify the RC0 outlier on the STABLE-APPEND structure, which is the
    // shape both arms share and therefore the one where a ratio difference is
    // attributable to cache rather than to structure.
    const stable = summaries.find(summary => summary.structure === 'stable-append')
    expect(stable).toBeDefined()
    if (stable !== undefined && stable.reuseRatio !== undefined) {
      // RC0-C's observed outlier, classified against the measured baseline.
      // This is the number RC1 §42 requires be attributed: nine of ten paired
      // runs landed in 0.776-0.984 and one was 2.265.
      const RC0_OUTLIER_RATIO = 2.265
      const classification = classifyAgainstBaseline({
        ratio: RC0_OUTLIER_RATIO,
        baselineReuseRatio: stable.reuseRatio,
        baselineComparable: stable.promptSizeComparable,
        failedRequests: stable.arms.reduce((sum, arm) => sum + arm.failedRequests, 0),
      })
      console.log(
        `RC0 OUTLIER (${RC0_OUTLIER_RATIO}) CLASSIFICATION: ${classification.cause}`,
      )
      for (const line of classification.evidence) console.log(`  - ${line}`)

      // And the same classifier on the baseline ratio itself, which is what the
      // microbench directly measured.
      const selfClassification = classifyOutlier({
        ratio: stable.reuseRatio,
        meanPromptTokensE: stable.meanPromptTokensE,
        meanPromptTokensB: stable.meanPromptTokensB,
        failedRequests: stable.arms.reduce((sum, arm) => sum + arm.failedRequests, 0),
        meanReuseE: stable.arms.find(arm => arm.arm === 'E')?.meanReuseWhenExpected,
        meanReuseB: stable.arms.find(arm => arm.arm === 'B')?.meanReuseWhenExpected,
      })
      console.log(`BASELINE SELF-CLASSIFICATION: ${selfClassification.cause}`)

      // The RC0-C signature, restated as the expectation RC1 §24 states: at
      // COMPARABLE prompt sizes, EF must not realize LESS reuse than Basic.
      // If it does, that is the provider cache-state effect rather than a
      // policy cost regression — and either way the number is reported.
      if (stable.promptSizeComparable) {
        expect(
          selfClassification.cause,
          'at comparable prompt sizes, an EF reuse deficit must be attributed to provider cache state',
        ).not.toBe('policy')
      }
    } else {
      console.log('CACHE: no reuse ratio available — the provider reported no cache counters')
    }

    // A root mutation SHOULD show a cold shock; that is the design, and
    // recording it is what makes "roots are rare" a priced decision.
    const root = summaries.find(summary => summary.structure === 'root-mutation')
    if (root !== undefined) {
      const cold = root.arms.find(arm => arm.arm === 'E')?.meanReuseWhenCold
      const expected = root.arms.find(arm => arm.arm === 'E')?.meanReuseWhenExpected
      console.log(`CACHE root: cold reuse=${cold?.toFixed(3) ?? 'n/a'} expected reuse=${expected?.toFixed(3) ?? 'n/a'}`)
      if (cold !== undefined && expected !== undefined) {
        expect(cold).toBeLessThanOrEqual(expected + 0.05)
      }
    }
  }, 900_000)
})
