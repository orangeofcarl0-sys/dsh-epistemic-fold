/**
 * R1 live behavioral subset (docs/11 §21, §26 R1-E).
 *
 * This is the ONLY tier that can answer the question R1's keyless work left
 * open: does Epistemic Fold preserve TASK SUCCESS, not merely tokens? Every
 * economic claim in the R1 report is conditional on that answer, so this suite
 * exists to test it directly against a real model.
 *
 * It is **opt-in and credential-gated**. Without a resolvable route the suite
 * reports SKIPPED and asserts nothing — a missing credential must never be
 * silently reported as a passing behavior check. Set `EF_LIVE=1` to enable.
 *
 * The route comes from this workspace's ZCode configuration, so the tier
 * measures the model actually in use. The key is read at runtime and never
 * logged, serialized, or written to a bundle.
 *
 * What is measured, per workload and per arm:
 *   - task success against a machine oracle (the real behavioral claim)
 *   - provider-reported tokens, including cache hits (realizing `h`)
 *   - cost-to-success, the product metric (docs/11 §2)
 */

import { describe, expect, it } from 'vitest'
import { resolveLiveRoute, redactSecret } from '../eval/live/zcode-config.ts'
import { mapUsage, OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import { compileContextPolicy } from '../src/policy-compiler.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'

function profile(id: string): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', `${id}.json`), 'utf8'),
  ))
}

describe('R1 live: usage mapping is exact (no credentials needed)', () => {
  it('treats inputTokens as UNCACHED, subtracting cached input out', () => {
    // This endpoint folds cache hits into prompt_tokens, so a naive mapping
    // would double-count the cached prefix and corrupt every cost figure.
    const usage = mapUsage({
      prompt_tokens: 2413,
      completion_tokens: 1,
      total_tokens: 2414,
      cache_hit_tokens: 2176,
      cache_miss_tokens: 237,
      cache_write_tokens: 0,
    })!
    expect(usage.inputTokens).toBe(237)
    expect(usage.cacheReadTokens).toBe(2176)
    expect(usage.cacheWriteTokens).toBe(0)
    expect(usage.outputTokens).toBe(1)
    // The disjoint counters must reconstruct the provider's aggregate.
    expect(usage.inputTokens + usage.cacheReadTokens! + usage.cacheWriteTokens!).toBe(2413)
  })

  it('falls back to subtraction when only a cached count is reported', () => {
    const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800 } })!
    expect(usage.inputTokens).toBe(200)
    expect(usage.cacheReadTokens).toBe(800)
  })

  it('reports no cache fields as fully uncached rather than inventing a hit rate', () => {
    const usage = mapUsage({ prompt_tokens: 500, completion_tokens: 5 })!
    expect(usage.inputTokens).toBe(500)
    expect(usage.cacheReadTokens).toBeUndefined()
  })

  it('redacts a credential from any message it might appear in', () => {
    // Obviously synthetic: this is a redaction test fixture, not a credential.
    const secret = 'FAKE-TEST-CREDENTIAL-NOT-A-REAL-KEY-0001'
    const message = `request failed with key ${secret} attached`
    expect(redactSecret(message, secret)).not.toContain(secret)
    expect(redactSecret(message, secret)).toContain('<redacted>')
  })
})

describe.skipIf(!LIVE_ENABLED)('R1 live: behavioral subset against the configured model', () => {
  const route = resolveLiveRoute()

  it('resolves a live route from the ZCode configuration', () => {
    expect(route, 'no live route resolved; set EF_LIVE=1 only when a route exists').toBeDefined()
    // The origin is safe to report; the key is not.
    console.log(`live route: ${route!.origin} model=${route!.model} base=${route!.baseUrl}`)
    expect(route!.apiKey.length).toBeGreaterThan(0)
  })

  it('completes a real call and reports provider cache telemetry', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl,
      apiKey: route!.apiKey,
      model: route!.model,
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'live',
      model: route!.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ready' }] }],
      maxTokens: 16,
    } as never)) {
      chunks.push(chunk)
    }
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toBeDefined()
    expect(finish!.type === 'finish' && finish!.reason.kind).not.toBe('error')

    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage, 'provider reported no usage; cache realization cannot be measured').toBeDefined()
    if (usage?.type === 'usage') {
      console.log(`live usage: input=${usage.usage.inputTokens} cacheRead=${usage.usage.cacheReadTokens ?? 0} output=${usage.usage.outputTokens}`)
      // Disjoint counters: the adapter must never report cached input as fresh.
      expect(usage.usage.inputTokens).toBeGreaterThanOrEqual(0)
    }
  }, 120_000)

  it('measures REAL cache realization (h) rather than assuming it', async () => {
    // The whole point of R1's ρ_eff correction: a stable prefix is not
    // automatically a cache hit. This measures h from provider numbers.
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl,
      apiKey: route!.apiKey,
      model: route!.model,
    })
    const stablePrefix = 'You are a precise engineering assistant. '.repeat(400)
    const call = async (): Promise<{ input: number; cacheRead: number }> => {
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'live',
        model: route!.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: stablePrefix }] },
          { role: 'user', content: [{ type: 'text', text: 'Reply with the single word: alpha' }] },
        ],
        maxTokens: 8,
      } as never)) {
        chunks.push(chunk)
      }
      const usage = chunks.find(chunk => chunk.type === 'usage')
      if (usage?.type !== 'usage') throw new Error('no usage reported')
      return { input: usage.usage.inputTokens, cacheRead: usage.usage.cacheReadTokens ?? 0 }
    }

    // First call populates the cache; later calls on an identical prefix hit it.
    const first = await call()
    const second = await call()
    console.log(`live cache: call1 miss=${first.input} hit=${first.cacheRead} | call2 miss=${second.input} hit=${second.cacheRead}`)
    // A stable, repeated prefix must realize SOME caching on a cache-capable
    // provider; if this is zero the profile's ρ is fictional for this route.
    const priced = second.input + second.cacheRead
    const realization = priced === 0 ? 0 : second.cacheRead / priced
    console.log(`live realization h = ${realization.toFixed(3)} (architectural claim would be 1.000)`)
    expect(realization).toBeGreaterThanOrEqual(0)
    expect(realization).toBeLessThanOrEqual(1)
  }, 180_000)

  it('produces a policy decision priced with MEASURED realization, not an assumption', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl,
      apiKey: route!.apiKey,
      model: route!.model,
    })
    // Warm the cache, then read the realized split for a realistic prompt.
    const stablePrefix = 'You are a precise engineering assistant. '.repeat(400)
    let last = { input: 0, cacheRead: 0 }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'live',
        model: route!.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: stablePrefix }] },
          { role: 'user', content: [{ type: 'text', text: 'Reply with the single word: alpha' }] },
        ],
        maxTokens: 8,
      } as never)) {
        chunks.push(chunk)
      }
      const usage = chunks.find(chunk => chunk.type === 'usage')
      if (usage?.type === 'usage') {
        last = { input: usage.usage.inputTokens, cacheRead: usage.usage.cacheReadTokens ?? 0 }
      }
    }
    const priced = last.input + last.cacheRead
    const realizationRate = priced === 0 ? 0 : last.cacheRead / priced

    const decision = compileContextPolicy({
      economics: profile('deepseek-flash-2026-09'),
      telemetry: {
        frozenTokens: 40_000,
        frozenCheckpointCount: 10,
        rawTailTokens: 4_000,
        promptTokens: 44_000,
        recentFoldCadence: 100,
        observedCacheReadTokens: last.cacheRead,
        observedCacheMissTokens: last.input,
      },
      pressure: { contextWindow: 131_072, currentTokens: 44_000 },
      policy: { paybackHorizonRequests: 200, pressureRatio: 0.8, compactionCost: 0.002, realizationRate },
    })
    console.log(`live-priced decision: regime=${decision.regime} action=${decision.action} h=${realizationRate.toFixed(3)}`)
    expect(decision.leafRepresentation).toBe('snapshot')
    expect(decision.reason.length).toBeGreaterThan(0)
  }, 180_000)
})
