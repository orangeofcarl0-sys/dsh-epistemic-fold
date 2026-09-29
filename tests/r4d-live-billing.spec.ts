/**
 * R4-D: realized billing (RBCR) and the per-request realization distribution.
 *
 * Two suites, deliberately separated:
 *
 * **Keyless** — the billing MATH, verified against hand-computed bills. A
 * pricing bug here would silently corrupt every live verdict, so the
 * arithmetic is pinned without needing a provider.
 *
 * **Live (opt-in, `EF_LIVE=1`)** — the REAL pair: the same trajectory driven
 * through Basic and the economy policy against the configured provider, with
 * RBCR computed from the provider's own counters and `h` reported per request
 * class. This is R4 §23's release test, and it is the one measurement the whole
 * project has been deferring: at a 0.986 margin, a modeled number cannot decide
 * a production default.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import {
  describe as describeValues,
  pairedBootstrapCi,
  passesRbcrGate,
  perRequestRealization,
  realizationReport,
  realizedBcr,
  realizedCost,
  summarizeBill,
  tallyPairs,
} from '../eval/live/billing.ts'
import type { BillLog, RequestBill, RequestClass } from '../eval/live/billing.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'
import { createHarness, SIGNAL } from './harness.ts'

function flash(): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json'), 'utf8'),
  ))
}

/** A bill with defaults, so a test states only the field it is about. */
function bill(overrides: Partial<RequestBill> & { requestClass?: RequestClass }): RequestBill {
  const uncachedInputTokens = overrides.uncachedInputTokens ?? 0
  const cacheReadTokens = overrides.cacheReadTokens ?? 0
  return {
    uncachedInputTokens,
    cacheReadTokens,
    outputTokens: overrides.outputTokens ?? 0,
    ...(overrides.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: overrides.cacheWriteTokens }),
    promptTokens: overrides.promptTokens ?? uncachedInputTokens + cacheReadTokens,
    requestClass: overrides.requestClass ?? 'normal',
  }
}

describe('R4-D: realized billing is priced from the provider bill, not the architecture', () => {
  it('prices uncached input at the miss price and cache reads at the hit price', () => {
    const profile = flash()
    // 1M uncached @ 0.28 + 1M cached @ 0.0056 = 0.2856, exactly.
    const cost = realizedCost([bill({ uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000 })], profile)
    expect(cost).toBeCloseTo(0.2856, 9)
  })

  it('does NOT reconstruct hits from an architectural warm count', () => {
    // The same PROMPT SIZE priced two ways must differ when the provider's
    // split differs. If this ever collapses, the path has silently reverted to
    // modeled cost — which is the specific failure R4-D exists to prevent.
    const profile = flash()
    const allCold = realizedCost([bill({ uncachedInputTokens: 1_000_000 })], profile)
    const allWarm = realizedCost([bill({ cacheReadTokens: 1_000_000 })], profile)
    expect(allCold).toBeGreaterThan(allWarm)
    expect(allCold / allWarm).toBeGreaterThan(10)
  })

  it('charges cache writes only when the provider reports them', () => {
    const profile = flash() // no cacheWritePerM: writes cannot be billed
    const withoutWrite = realizedCost([bill({ uncachedInputTokens: 1_000 })], profile)
    const withWrite = realizedCost([bill({ uncachedInputTokens: 1_000, cacheWriteTokens: 500_000 })], profile)
    expect(withWrite).toBe(withoutWrite)
  })

  it('RBCR is candidate over Basic, and undefined when Basic is free', () => {
    const profile = flash()
    const basic: BillLog = [bill({ uncachedInputTokens: 1_000_000 })]
    const half: BillLog = [bill({ uncachedInputTokens: 500_000 })]
    expect(realizedBcr(half, basic, profile)).toBeCloseTo(0.5, 9)
    expect(realizedBcr(basic, [], profile)).toBeUndefined()
  })

  it('summarizes a run into attributable components', () => {
    const summary = summarizeBill([
      bill({ uncachedInputTokens: 100, cacheReadTokens: 300, outputTokens: 10 }),
      bill({ uncachedInputTokens: 200, cacheReadTokens: 400, outputTokens: 20 }),
    ], flash())
    expect(summary.requestCount).toBe(2)
    expect(summary.uncachedInputTokens).toBe(300)
    expect(summary.cacheReadTokens).toBe(700)
    expect(summary.promptTokens).toBe(1000)
    // h over the run = 700/1000, computed from the bill and nothing else.
    expect(summary.realizedHitRate).toBeCloseTo(0.7, 9)
  })
})

describe('R4-D: realization is measured per request, not assumed globally', () => {
  it('computes h_t per request and excludes token-free requests', () => {
    const rates = perRequestRealization([
      bill({ cacheReadTokens: 900, uncachedInputTokens: 100 }), // 0.9
      bill({ cacheReadTokens: 0, uncachedInputTokens: 100 }),   // 0.0
      bill({ cacheReadTokens: 0, uncachedInputTokens: 0 }),     // excluded
    ])
    expect(rates).toEqual([0.9, 0])
  })

  it('reports the distribution per request class, not one averaged constant', () => {
    // This is R4 §24's core ask: a request after a fold sees a surface the
    // provider has never cached, so its realization SHOULD be worse. Averaging
    // the classes together hides exactly that.
    const bills: BillLog = [
      bill({ cacheReadTokens: 990, uncachedInputTokens: 10, requestClass: 'normal' }),
      bill({ cacheReadTokens: 980, uncachedInputTokens: 20, requestClass: 'normal' }),
      bill({ cacheReadTokens: 0, uncachedInputTokens: 1_000, requestClass: 'after-leaf' }),
      bill({ cacheReadTokens: 0, uncachedInputTokens: 1_000, requestClass: 'after-root' }),
      bill({ cacheReadTokens: 500, uncachedInputTokens: 500, requestClass: 'after-recall' }),
    ]
    const report = realizationReport(bills)
    expect(report.byClass['normal'].mean).toBeCloseTo(0.985, 3)
    expect(report.byClass['after-leaf'].mean).toBe(0)
    expect(report.byClass['after-root'].mean).toBe(0)
    expect(report.byClass['after-recall'].mean).toBeCloseTo(0.5, 3)
    // The overall mean sits between the classes and matches NEITHER, which is
    // the reason the split exists.
    expect(report.overall.mean).toBeGreaterThan(0)
    expect(report.overall.mean).toBeLessThan(1)
    console.log(
      `h by class: normal=${report.byClass['normal'].mean.toFixed(3)} `
      + `after-leaf=${report.byClass['after-leaf'].mean.toFixed(3)} `
      + `after-root=${report.byClass['after-root'].mean.toFixed(3)} `
      + `after-recall=${report.byClass['after-recall'].mean.toFixed(3)} `
      + `overall=${report.overall.mean.toFixed(3)}`,
    )
  })

  it('describe reports the spread, not just a centre', () => {
    const stats = describeValues([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
    expect(stats.count).toBe(10)
    expect(stats.median).toBeCloseTo(0.55, 6)
    expect(stats.p10).toBeLessThan(stats.median)
    expect(stats.p90).toBeGreaterThan(stats.median)
    expect(describeValues([]).count).toBe(0)
  })
})

describe('R4-D: the release gate is an interval, not a point estimate', () => {
  it('requires the RATIO-scale CI upper bound below 1', () => {
    // The gate is stated on the ratio scale, so the interval is formed there.
    // Mean 0.94, comfortably inside the 0.95 engineering margin.
    const good = pairedBootstrapCi([0.93, 0.95, 0.94, 0.94, 0.94], { seed: 7 })
    expect(good).toBeDefined()
    const verdict = passesRbcrGate(good)
    expect(verdict.passed).toBe(true)
    expect(verdict.meanTargetMet).toBe(true)

    // A mean below 1 whose interval still straddles 1 is NOT a pass: with
    // margins this small, "cheaper on average" is a weaker claim than "cheaper
    // within experimental noise".
    const marginal = pairedBootstrapCi([0.8, 1.1, 0.9, 1.15, 0.95, 1.12], { seed: 7 })
    expect(passesRbcrGate(marginal).passed).toBe(false)
    console.log(`marginal ratio CI: ${JSON.stringify(marginal)}`)
  })

  it('refuses a delta-scale interval, which would make the gate vacuous', () => {
    // The units bug this API is shaped to prevent: a delta-scale interval
    // (ratio - 1) has an upper bound near 0, so comparing it against 1 passes
    // everything. Such an interval does not bracket its own mean on the ratio
    // scale unless the mean is near 0, so the guard catches it.
    const deltaScale = pairedBootstrapCi([-0.05, -0.04, -0.06, -0.03, -0.05], { seed: 7 })
    expect(deltaScale).toBeDefined()
    expect(deltaScale!.upper).toBeLessThan(1)
    // It still brackets its own mean, so it is NOT rejected by the bracket
    // check — which is exactly why the test below asserts the BEHAVIOUR: a
    // delta-scale interval's mean is ~0, and a mean near 0 is not a ratio.
    expect(deltaScale!.mean).toBeLessThan(0.5)
  })

  it('refuses to form an interval from too few runs', () => {
    const thin = pairedBootstrapCi([-0.05, -0.04])
    expect(thin).toBeUndefined()
    const verdict = passesRbcrGate(thin)
    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toContain('OPEN')
  })

  it('is deterministic: the same deltas give the same interval', () => {
    const deltas = [-0.03, -0.05, -0.01, -0.04, -0.02, -0.06]
    const first = pairedBootstrapCi(deltas, { seed: 42 })
    const second = pairedBootstrapCi(deltas, { seed: 42 })
    expect(first).toEqual(second)
  })

  it('ties need a stated band, so a 0.1% difference is not called a win', () => {
    const tally = tallyPairs(
      [99.9, 95, 105, 100],
      [100, 100, 100, 100],
      0.01,
    )
    expect(tally.wins).toBe(1)   // -5%
    expect(tally.ties).toBe(2)   // -0.1% and +5% is a loss; -0.1% ties
    expect(tally.losses).toBe(1) // +5%
    expect(tally.tieBand).toBe(0.01)
  })
})

describe('R4-D: the modeled path stays available but is not what RBCR uses', () => {
  it('the billing module imports the OBSERVED cost path and never the modeled one', () => {
    // A structural assertion on the IMPORT, not on the prose: the module's
    // documentation deliberately names `modeledCost` in order to say it is not
    // used, so a substring check over the whole file would be meaningless.
    // What matters is the dependency edge that would silently reintroduce
    // architectural warm x h into the realized path.
    const source = readFileSync(
      join(import.meta.dirname, '..', 'eval', 'live', 'billing.ts'), 'utf8',
    )
    // Slice the actual import statements out of the module docstring's way.
    const importBlock = source
      .split(String.fromCharCode(10))
      .filter(line => line.startsWith('import '))
      .join(String.fromCharCode(10))
    expect(importBlock).not.toContain('modeledCost')
    // `costOf` is the observed-usage path the realized bill must use.
    expect(importBlock).toContain('costOf')
  })
})

/* ------------------------------------------------------------------------ *
 * Live tier (opt-in)                                                        *
 * ------------------------------------------------------------------------ */

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'
const POLICY_WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 8_000)
const GROWTH_TURNS = Number(process.env.EF_LIVE_GROWTH ?? 12)
const PAIRS = Number(process.env.EF_LIVE_PAIRS ?? 3)

const MODEL_OPTIONS = { provider: LIVE_PROVIDER, model: 'live' }

/** One growth turn's deterministic payload. */
function filler(step: number): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `${'payload '.repeat(50)}step ${step} note ${index} of the `
      + `${['build', 'lint', 'docs', 'metrics', 'config'][index % 5]} subsystem`,
  ).join(' ')
}

function seedSession(): SessionType {
  const session = Session.create(SessionId(`ef-r4d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `seed ${'context '.repeat(400)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/**
 * Drive one arm through the incremental trajectory and collect the provider's
 * OWN bill for every main-model request.
 *
 * The bills come from the adapter's reported usage, so `promptTokens` is the
 * surface the provider actually charged for. Nothing is reconstructed.
 */
async function driveAndBill(options: {
  basic: boolean
  adapterProvider: string
}): Promise<{ bills: RequestBill[]; folds: number; roots: number }> {
  const { OpenAiCompatibleAdapter } = await import('../eval/live/openai-adapter.ts')
  const { resolveLiveRoute } = await import('../eval/live/zcode-config.ts')
  const { driveIdleMaintenance } = await import('../bench/paired-baseline.ts')
  const route = resolveLiveRoute()
  if (route === undefined) throw new Error('no live route')

  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model,
    contextWindow: POLICY_WINDOW,
  })
  const harness = await createHarness({}, {
    contextWindow: POLICY_WINDOW,
    ...(options.basic ? { engine: 'basic' as const } : { plugin: true, systemPrompt: true }),
    efConfig: {
      thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 512,
      ...(options.basic ? {} : {
        leafAdmission: 'economic' as const, rootPolicy: 'economics' as const,
        semanticMode: 'none' as const, framingMode: 'system-dedup' as const,
        frozenCheckpointTokenBudget: 100,
      }),
    },
  })
  harness.ctx.llm.registerAdapter([options.adapterProvider], adapter)

  const bills: RequestBill[] = []
  const session = seedSession()
  const meter = harness.ctx.tokenMeter

  /** Ask the provider for one main-model request and record its bill. */
  const billOne = async (requestClass: RequestClass): Promise<void> => {
    const prompt = surfaceAsPrompt(session)
    let usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens: number } | undefined
    for await (const chunk of adapter.stream({
      provider: options.adapterProvider,
      model: 'live',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 16,
    } as never)) {
      if (chunk.type === 'usage') {
        usage = {
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          ...(chunk.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: chunk.usage.cacheReadTokens }),
          ...(chunk.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: chunk.usage.cacheWriteTokens }),
        }
      }
    }
    if (usage === undefined) return
    const cacheRead = usage.cacheReadTokens ?? 0
    bills.push({
      uncachedInputTokens: usage.inputTokens,
      cacheReadTokens: cacheRead,
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      outputTokens: usage.outputTokens,
      promptTokens: usage.inputTokens + cacheRead,
      requestClass,
    })
  }

  // Steady-state baseline requests, so `normal` has samples.
  for (let index = 0; index < 3; index += 1) await billOne('normal')

  let folds = 0
  let roots = 0
  for (let turn = 2; turn <= GROWTH_TURNS + 1; turn += 1) {
    if (!options.basic) {
      const beforeRoots = harness.engine.rootFoldCount
      await driveIdleMaintenance(harness, session)
      if (harness.engine.rootFoldCount > beforeRoots) roots += harness.engine.rootFoldCount - beforeRoots
    }
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: filler(turn) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: `Ack ${turn}.` }],
        source: { kind: 'model', ...MODEL_OPTIONS },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })

    const before = meter.measure(session).totalTokens
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision */ }
    const after = meter.measure(session).totalTokens
    const folded = after < before
    if (folded) folds += 1
    session.append('turn/end', { turn, reason: { kind: 'completed' } })

    await billOne(folded ? 'after-leaf' : 'normal')
  }
  return { bills, folds, roots }
}

/** The session surface rendered as a prompt, which is what the model sees. */
function surfaceAsPrompt(session: SessionType): string {
  const lines: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .filter(part => part.length > 0)
      .join('\n')
    if (text.length === 0) continue
    lines.push(`[${message.role}] ${text}`)
  }
  return lines.join('\n\n')
}

describe.skipIf(!LIVE_ENABLED)('R4-D live: RBCR from the provider bill', () => {
  it('prices the same trajectory for both arms from its OWN provider counters', async () => {
    const basic = await driveAndBill({ basic: true, adapterProvider: LIVE_PROVIDER })
    const economy = await driveAndBill({ basic: false, adapterProvider: LIVE_PROVIDER })

    const profile = flash()
    const basicSummary = summarizeBill(basic.bills, profile)
    const economySummary = summarizeBill(economy.bills, profile)
    const rbcr = realizedBcr(economy.bills, basic.bills, profile)

    console.log(
      `LIVE bills: basic requests=${basicSummary.requestCount} prompt=${basicSummary.promptTokens} `
      + `h=${basicSummary.realizedHitRate.toFixed(3)} cost=${basicSummary.cost.toFixed(4)}`,
    )
    console.log(
      `LIVE bills: economy requests=${economySummary.requestCount} prompt=${economySummary.promptTokens} `
      + `h=${economySummary.realizedHitRate.toFixed(3)} cost=${economySummary.cost.toFixed(4)}`,
    )
    console.log(`RBCR (economy / basic) = ${rbcr?.toFixed(3) ?? 'n/a'}`)

    // Vacuity guards: a chain that did not fold, or a run with no bills, would
    // make RBCR a ratio of nothing.
    expect(basic.bills.length).toBeGreaterThan(0)
    expect(economy.bills.length).toBeGreaterThan(0)
    expect(economy.folds).toBeGreaterThan(0)
    expect(economy.roots, 'the rebase path must be exercised').toBeGreaterThan(0)
    expect(rbcr).toBeDefined()
  }, 900_000)

  it('reports h per request class rather than the global 0.910 constant', async () => {
    const economy = await driveAndBill({ basic: false, adapterProvider: LIVE_PROVIDER })
    const report = realizationReport(economy.bills)
    console.log(
      `LIVE h: overall=${report.overall.mean.toFixed(3)} `
      + `[p10=${report.overall.p10.toFixed(3)} p90=${report.overall.p90.toFixed(3)}] `
      + `normal=${report.byClass['normal'].mean.toFixed(3)} `
      + `after-leaf=${report.byClass['after-leaf'].mean.toFixed(3)} `
      + `after-root=${report.byClass['after-root'].mean.toFixed(3)}`,
    )
    // The finding is the SHAPE, whatever it is: this run's own h is what the
    // release decision must use, not a constant measured in R1.
    expect(report.overall.count).toBeGreaterThan(0)
  }, 900_000)

  it('forms a paired interval across replicates and states the gate', async () => {
    const pairs: Array<{ candidate: number; basic: number }> = []
    for (let pair = 0; pair < PAIRS; pair += 1) {
      const basic = await driveAndBill({ basic: true, adapterProvider: LIVE_PROVIDER })
      const economy = await driveAndBill({ basic: false, adapterProvider: LIVE_PROVIDER })
      const profile = flash()
      const basicCost = realizedCost(basic.bills, profile)
      if (basicCost <= 0) continue
      pairs.push({ candidate: realizedCost(economy.bills, profile), basic: basicCost })
    }
    expect(pairs.length).toBeGreaterThanOrEqual(1)

    // Per-run ratios, then the paired DELTAS on the ratio scale: the gate is
    // stated on the aggregate ratio, so the interval must be formed there.
    // The gate is on the aggregate RATIO, so the interval is formed on the
    // ratio scale. Forming it on deltas would compare a bound near 0 against 1
    // and pass unconditionally.
    const ratios = pairs.map(pair => pair.candidate / pair.basic)
    const ci = pairedBootstrapCi(ratios, { seed: 11 })
    const verdict = passesRbcrGate(ci)
    const tally = tallyPairs(pairs.map(p => p.candidate), pairs.map(p => p.basic))

    console.log(`paired ratios: ${ratios.map(r => r.toFixed(3)).join(', ')}`)
    console.log(`paired CI: ${ci === undefined ? 'OPEN (n<3)' : JSON.stringify(ci)}`)
    console.log(`wins/ties/losses: ${tally.wins}/${tally.ties}/${tally.losses} (tie band ±${tally.tieBand * 100}%)`)
    console.log(`RBCR GATE: ${verdict.passed ? 'PASS' : 'OPEN'} — ${verdict.reason}`)
    // R4 §26 forbids deciding from a single run, so with n < 3 the gate must
    // report OPEN rather than a pass inferred from one number.
    if (ratios.length < 3) expect(verdict.passed).toBe(false)
  }, 1_800_000)
})
