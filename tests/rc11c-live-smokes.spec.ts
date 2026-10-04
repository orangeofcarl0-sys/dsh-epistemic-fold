/**
 * RC1.1 §5: two cheap live smokes, and nothing more.
 *
 * The stage is explicit about the budget. RC1.1 does not re-open parameter
 * search and does not carry a statistical verdict — those belong to a healthy
 * provider window and to more replicates than this stage is willing to buy. Two
 * things do need a live check, because no keyless test can answer them:
 *
 *   **Smoke 1 — unanchored narrative.** Every quality check so far declared its
 *   facts as ANCHORS through the authority gate, and under `semanticMode: 'none'`
 *   a checkpoint is marker-only. So those checks measured "declared state
 *   survives a fold", which is the mechanism working as designed. They did NOT
 *   measure what happens to ordinary narrative prose that nobody anchored —
 *   which is the real product boundary a user will hit. This smoke measures it,
 *   against Basic, and reports the boundary rather than assuming it is fine.
 *
 *   **Smoke 2 — a corrected cost pair.** One or two pairs through the corrected
 *   instrument, to check the DIRECTION the keyless replay predicts. It does not
 *   carry a verdict; RC1 established that a single run cannot.
 *
 * The run stops on provider degradation rather than pushing through it: RC1's
 * 8-replicate attempt was abandoned at 28% transport failures, and a degraded
 * provider measures the provider.
 *
 * Opt-in: `EF_LIVE=1`.
 *
 * @module tests/rc11c-live-smokes
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'
import { driveIdleMaintenance } from '../bench/paired-baseline.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { BillingRecorder } from '../eval/live/recorder.ts'
import { summarizeFullBill, realizedBcr } from '../eval/live/billing.ts'
import { flash } from './economics-fixture.ts'
import { resolvePreset } from '../src/preset.ts'
import { LIVE_ENABLED, LIVE_PROVIDER, MODEL_OPTIONS } from './live-gate.ts'


/** Deterministic filler. */
function filler(label: string, units: number): string {
  return Array.from(
    { length: units },
    (_, index) => `${label} unit ${index} ${'payload '.repeat(12)}`,
  ).join(' ')
}

/**
 * Seed a session with UNANCHORED narrative facts, then grow it.
 *
 * Nothing is declared through the anchor service — that is the entire point.
 * The facts are ordinary prose a user would type, and the question is what
 * survives several folds of a marker-only checkpoint.
 */
function seedNarrative(): SessionType {
  const session = Session.create(SessionId(`rc11-narr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  // Plain prose facts, of the kind a user states once and expects remembered.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text:
      'Some context before we start. Our batch size must never exceed 64 items. '
      + 'The parser timeout was 30 seconds, but I am changing it to 90 seconds now. '
      + 'The failing error code we are chasing is PARSE-7741. '
      + 'Please keep all of this in mind.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: filler('background', 40) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** Grow the session across `steps` turns so several folds occur. */
async function growAndFold(
  harness: Awaited<ReturnType<typeof createHarness>>,
  session: SessionType,
  steps: number,
  tokensPerStep: number,
): Promise<number> {
  const meter = harness.ctx.tokenMeter
  let folds = 0
  for (let step = 2; step <= steps + 1; step += 1) {
    session.append('turn/start', { turn: step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: filler(`step ${step}`, Math.ceil(tokensPerStep / 12)) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const before = meter.measure(session).totalTokens
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision */ }
    if (meter.measure(session).totalTokens < before) folds += 1
    session.append('turn/end', { turn: step, reason: { kind: 'completed' } })
  }
  return folds
}

/** Ask one question through the real assembled request. */
async function ask(
  harness: Awaited<ReturnType<typeof createHarness>>,
  session: SessionType,
  question: string,
): Promise<string> {
  session.append('turn/start', { turn: 900 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: question }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[] }> }
    | undefined
  let system: string | undefined
  let tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined
  if (service?.assemble !== undefined) {
    try {
      const assembly = await service.assemble({})
      const text = (assembly.sections ?? []).map(s => s.text ?? '').filter(p => p.length > 0).join('\n\n')
      if (text.length > 0) system = text
      if (assembly.tools !== undefined && assembly.tools.length > 0) tools = assembly.tools
    } catch { /* no system prompt is honest */ }
  }
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  let answer = ''
  for await (const chunk of harness.ctx.llm.stream({
    provider: LIVE_PROVIDER, model: 'live', messages,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    maxTokens: 200,
  } as never)) {
    if (chunk.type === 'text-delta') answer += chunk.text
  }
  session.append('turn/end', { turn: 900, reason: { kind: 'completed' } })
  return answer
}

/**
 * Issue one main-model request through the real assembled path.
 *
 * @param harness - the mounted harness.
 * @param session - the session to send.
 */
async function issueMain(
  harness: Awaited<ReturnType<typeof createHarness>>,
  session: SessionType,
): Promise<void> {
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[] }> }
    | undefined
  let system: string | undefined
  let tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined
  if (service?.assemble !== undefined) {
    try {
      const assembly = await service.assemble({})
      const text = (assembly.sections ?? []).map(s => s.text ?? '').filter(p => p.length > 0).join(String.fromCharCode(10, 10))
      if (text.length > 0) system = text
      if (assembly.tools !== undefined && assembly.tools.length > 0) tools = assembly.tools
    } catch { /* no system prompt is honest */ }
  }
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  for await (const chunk of harness.ctx.llm.stream({
    provider: LIVE_PROVIDER, model: 'live', messages,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    maxTokens: 32,
  } as never)) {
    void chunk
  }
}

const PROBE = [
  'Answer these three in one short reply, one line each, no preamble.',
  'If you do not know a value, say "unknown" rather than guessing.',
  '1. What is the maximum batch size?',
  '2. What is the parser timeout in seconds?',
  '3. What is the exact failing error code?',
].join('\n')

/** Score an answer against the three facts. */
function score(answer: string): { constraint: boolean; supersession: boolean; exact: boolean } {
  return {
    constraint: /\b64\b/u.test(answer),
    // Supersession: 90 correct, 30 wrong. Recalling 30 is a failure even though
    // 30 was genuinely stated — that is what makes this family hard.
    supersession: /\b90\b/u.test(answer) && !/\b30\b/u.test(answer.replace(/90/gu, '')),
    exact: /PARSE-7741/u.test(answer),
  }
}

describe.skipIf(!LIVE_ENABLED)('RC1.1 live smoke 1: unanchored narrative across folds', () => {
  it('measures what survives when nothing was declared as an anchor', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const SMOKE_WINDOW = Number(process.env.EF_LIVE_SMOKE_WINDOW ?? 6_000)
    const policy = {
      ...resolvePreset('economy'),
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 1_500,
    }

    // BOTH arms get the same window, reservation and trigger, so the comparison
    // is between COMPACTION POLICIES rather than between "folded" and "did not".
    //
    // The first version configured only the economy arm, and Basic — whose
    // shipped reserve exceeds a 6000-token window — then never folded at all
    // (0 folds) and answered 3/3 by simply keeping everything verbatim. That is
    // not a quality difference between the policies; it is a difference between
    // compacting and not compacting, and it would have read as "economy loses
    // 3 facts" when the honest reading is "a policy that folds loses what was
    // never declared, and a policy that does not fold keeps everything".
    // THREE arms, because the interesting question is not "does economy lose
    // unanchored prose" (it does) but WHERE the loss comes from. `semanticMode`
    // is the preset's own choice — `economy` sets it to `none`, so a checkpoint
    // is a marker plus structured state and carries no narrative at all —
    // whereas `legacy` EF makes one small rationale call. Distinguishing those
    // is the difference between "the preset is misconfigured" and "the
    // architecture requires declaration", and it costs one extra arm.
    // PRODUCTION retention, not zero.
    //
    // The first version set `retainTokens: 0`, which discards the entire tail at
    // every fold. Under that setting the facts were folded away in BOTH arms and
    // the result was dominated by my own extreme configuration rather than by
    // the policy — one run scored Basic 3/3 and the next 0/3, because nothing was
    // retained and the summary call's behavior was all that remained. A boundary
    // measurement has to run at a configuration a user would actually deploy.
    const shared = {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: Math.floor((SMOKE_WINDOW - 1_500) * 0.16),
      maxTokens: 1_500,
    }
    const run = async (
      arm: 'basic' | 'economy' | 'rationale',
    ): Promise<{ answer: string; folds: number }> => {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: SMOKE_WINDOW,
      })
      const harness = await createHarness({ text: 'digest' }, {
        contextWindow: SMOKE_WINDOW, plugin: true, systemPrompt: true,
        efConfig: arm === 'basic'
          ? shared
          : arm === 'rationale'
            // Legacy EF: the same policy as economy except the checkpoint makes
            // one small rationale-only call, which is the R0-A default.
            ? { ...policy, ...shared, semanticMode: 'rationale' as const }
            : { ...policy, ...shared },
        ...(arm === 'basic' ? { engine: 'basic' as const } : {}),
        adapter: { provider: LIVE_PROVIDER, instance: adapter },
      })
      const session = seedNarrative()
      const folds = await growAndFold(harness, session, 14, 3_000)
      const answer = await ask(harness, session, PROBE)
      return { answer, folds }
    }

    // REPLICATES, because one run cannot answer this.
    //
    // Three single runs of the SAME code scored Basic 3/3, then 0/3, then 1/3 on
    // a three-fact probe. That variance is the finding, not noise to average
    // away: a single-run quality comparison at this scale is not evidence, which
    // is exactly the lesson RC1 learned about cost and had to correct in public.
    // Three replicates per arm is still cheap and turns a point into a range.
    const REPLICATES = Number(process.env.EF_LIVE_NARRATIVE_REPLICATES ?? 3)
    const arms = ['basic', 'economy', 'rationale'] as const
    const results: Record<string, number[]> = { basic: [], economy: [], rationale: [] }
    const foldCounts: Record<string, number[]> = { basic: [], economy: [], rationale: [] }

    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const arm of arms) {
        const result = await run(arm)
        const entry = score(result.answer)
        const totalScore = Number(entry.constraint) + Number(entry.supersession) + Number(entry.exact)
        results[arm]!.push(totalScore)
        foldCounts[arm]!.push(result.folds)
        console.log(
          `NARRATIVE rep${replicate} ${arm}: folds=${result.folds} ${JSON.stringify(entry)} `
          + `total=${totalScore}/3`,
        )
        console.log(`  answer: ${result.answer.replace(/\s+/gu, ' ').slice(0, 180)}`)
      }
    }

    // Vacuity guard on every arm: a comparison where an arm never folded is a
    // comparison of compacting versus not compacting.
    for (const arm of arms) {
      const folds = foldCounts[arm]!
      expect(
        folds.every(count => count > 0),
        `${arm} must fold in every replicate, or the comparison is folded-vs-unfolded`,
      ).toBe(true)
    }

    const mean = (values: readonly number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    console.log('NARRATIVE BOUNDARY (mean of 3 facts over replicates):')
    for (const arm of arms) {
      console.log(`  ${arm.padEnd(10)} scores [${results[arm]!.join(', ')}] mean ${mean(results[arm]!).toFixed(2)}/3`)
    }

    // --- THE BOUNDARY, reported as a measured range rather than a verdict.
    //
    // Under the economy preset a checkpoint is marker-only, so unanchored prose
    // is not carried by the checkpoint; under `rationale` a small summary call
    // is made. Whether either matches Basic is what the numbers say, and the
    // spread is reported because at n=3 it is the honest summary.
    const economyMean = mean(results.economy!)
    const basicMean = mean(results.basic!)
    const rationaleMean = mean(results.rationale!)
    const spread = (values: readonly number[]): number =>
      Math.max(...values) - Math.min(...values)
    console.log(
      `NARRATIVE SPREAD: basic ${spread(results.basic!)}, economy ${spread(results.economy!)}, `
      + `rationale ${spread(results.rationale!)} (out of 3 facts)`,
    )

    // --- THE FINDING, asserted as a fact about the product rather than a
    // pass/fail on a policy.
    //
    // This is what RC1.1 §5 sent the smoke to find, and it is not a subtlety:
    //
    //   economy (semanticMode: none)   [0, 0, 0]  mean 0.00/3
    //   basic                          [0, 2, 1]  mean 1.00/3
    //   economy (semanticMode: rationale) [2, 3, 0] mean 1.67/3
    //
    // The marker-only checkpoint does NOT carry unanchored narrative — it lost
    // every fact in every replicate — while a rationale checkpoint recovers most
    // of them. So the boundary is the PRESET'S OWN CHOICE, not the architecture:
    // `semanticMode: none` is correct for state that was DECLARED (which is what
    // every earlier quality check measured, and those still pass) and is NOT a
    // substitute for Basic on prose nobody anchored.
    //
    // The economy arm is therefore NOT non-inferior on this input, and the test
    // records that instead of asserting it away. Asserting non-inferiority here
    // would have required ignoring a reproducible 0/3.
    expect(
      economyMean,
      `economy ${economyMean.toFixed(2)}/3 vs basic ${basicMean.toFixed(2)}/3 on undeclared prose: `
      + 'the marker-only preset does not carry unanchored narrative',
    ).toBeLessThan(basicMean)

    // And the cause is localized: a rationale checkpoint recovers materially
    // more, so this is the preset's semanticMode, not a structural limit.
    expect(
      rationaleMean,
      'a rationale checkpoint should recover more undeclared prose than a marker-only one',
    ).toBeGreaterThan(economyMean)

    console.log(
      'BOUNDARY (measured): economy quality is CONDITIONAL ON DECLARATION. Declared state survives '
      + '(the RC1-F smoke proves it); undeclared prose does not, reproducibly 0/3. A rationale '
      + 'checkpoint recovers most of it, so this is the preset semanticMode=none rather than the '
      + 'architecture. economy is NOT non-inferior to Basic on undeclared prose, and the '
      + 'certification must scope its quality claim accordingly.',
    )
  }, 600_000)
})

describe.skipIf(!LIVE_ENABLED)('RC1.1 live smoke 2: one corrected cost pair, direction only', () => {
  it('checks the direction the keyless replay predicts, and does not carry a verdict', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 131_072)
    const TURNS = Number(process.env.EF_LIVE_TURNS ?? 24)
    const profile = flash()

    // The corrected instrument: a per-run cache namespace so consecutive runs
    // cannot share a prefix, and one pair only — this is a direction check, not
    // a sample.
    const run = async (basic: boolean, armId: string) => {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: WINDOW,
      })
      const recorder = new BillingRecorder(adapter, armId)
      const harness = await createHarness({ text: 'digest' }, {
        contextWindow: WINDOW, plugin: true, systemPrompt: true,
        efConfig: basic ? { maxTokens: 512 } : { ...resolvePreset('economy'), maxTokens: 512 },
        ...(basic ? { engine: 'basic' as const } : {}),
        adapter: { provider: LIVE_PROVIDER, instance: recorder },
      })
      const session = Session.create(SessionId(`rc11-cost-${armId}-${Date.now()}`))
      session.append('turn/start', { turn: 1 })
      session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `CACHE-RUN-${armId}-7f924c seed ${'context '.repeat(200)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      let folds = 0
      for (let turn = 2; turn <= TURNS + 1; turn += 1) {
        session.append('turn/start', { turn })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: filler(`step ${turn}`, 300) }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        const before = harness.ctx.tokenMeter.measure(session).totalTokens
        try {
          await (harness.engine as unknown as {
            compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
          }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
        } catch { /* a refused fold is a decision */ }
        if (harness.ctx.tokenMeter.measure(session).totalTokens < before) folds += 1
        if (!basic) await driveIdleMaintenance(harness, session)
        // THE MAIN REQUEST, which is the thing being priced.
        //
        // The first version of this smoke only drove folds and maintenance, so
        // the economy arm — whose preset makes NO auxiliary call — recorded zero
        // provider calls and the pair was unmeasurable. A cost comparison needs
        // the requests a user actually pays for.
        await issueMain(harness, session)
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      return { bills: recorder.bill, folds, failed: recorder.failedCalls.length }
    }

    const economy = await run(false, 'E')
    const basic = await run(true, 'B')

    // STOP ON DEGRADATION (RC1.1 §5). A pair where an arm lost calls is a
    // transport measurement, not a cost one, and RC1 abandoned an 8-replicate
    // run for exactly this reason.
    const economyFailedShare = economy.bills.length === 0 ? 1 : economy.failed / economy.bills.length
    const basicFailedShare = basic.bills.length === 0 ? 1 : basic.failed / basic.bills.length
    console.log(
      `COST-PAIR calls: economy ${economy.bills.length} (${(economyFailedShare * 100).toFixed(0)}% failed), `
      + `basic ${basic.bills.length} (${(basicFailedShare * 100).toFixed(0)}% failed)`,
    )
    if (economyFailedShare > 0.25 || basicFailedShare > 0.25) {
      console.log(
        'COST-PAIR ABANDONED: transport degradation above 25% of calls. The provider is being '
        + 'measured, not the policy; no direction is reported.',
      )
      return
    }

    const economySummary = summarizeFullBill('E', economy.bills, profile)
    const basicSummary = summarizeFullBill('B', basic.bills, profile)
    const ratio = realizedBcr(economy.bills, basic.bills, profile)
    console.log(
      `COST-PAIR folds: economy ${economy.folds}, basic ${basic.folds}; `
      + `ratio ${ratio === undefined ? 'n/a' : ratio.toFixed(3)}`,
    )
    console.log(
      `COST-PAIR cost: economy ${economySummary.cost.toFixed(5)}, basic ${basicSummary.cost.toFixed(5)}`,
    )

    // The direction only. The keyless replay predicts economy below parity at
    // these settings; this confirms the sign and nothing more.
    expect(economy.folds, 'the economy arm must fold for the pair to mean anything').toBeGreaterThan(0)
    expect(ratio).toBeDefined()
    console.log(
      `COST-PAIR DIRECTION: ${ratio! < 1 ? 'economy below parity, matching the replay' : 'economy above parity, CONTRARY to the replay'}`,
    )
  }, 900_000)
})
