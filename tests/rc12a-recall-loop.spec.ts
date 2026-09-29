/**
 * RC1.2-A: the recall smoke that actually executes tools.
 *
 * RC1.1's narrative smoke asked the model a question and collected text deltas.
 * It never executed a tool call, so a model that correctly decided "this fact is
 * in an older checkpoint, I should search for it" had no way to act — the probe
 * could only observe what the SURFACE carried. That supports:
 *
 *   the marker-only checkpoint surface does not directly retain undeclared narrative
 *
 * and it does NOT support the stronger claim that was written down:
 *
 *   EF economy cannot recover undeclared narrative
 *
 * `context_search` and `context_recall` are exactly the mechanism EF provides
 * for recovering folded raw history, and they were never invoked. So this smoke
 * drives a real loop, bounded to a few rounds and recording what the loop
 * actually did (calls, recalled tokens, cost) rather than only the final answer.
 *
 * The loop itself now lives in `tests/recall-loop.ts`, shared with RC1.3, so the
 * two suites cannot drift: RC1.3 changes only the PROBE TEXT and the ANALYSIS,
 * which is what makes a difference between their results attributable to the
 * probe rather than to two subtly different harnesses.
 *
 * @module tests/rc12a-recall-loop
 */

import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.ts'
import {
  FACTS,
  FACT_PROBES,
  growAndFold,
  MAX_ROUNDS,
  runRecallLoop,
  scoreAnswer,
  seedNarrative,
} from './recall-loop.ts'
import type { LoopOutcome } from './recall-loop.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { BillingRecorder } from '../eval/live/recorder.ts'
import { summarizeFullBill } from '../eval/live/billing.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'
import { resolvePreset } from '../src/preset.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'

function flash(): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json'), 'utf8'),
  ))
}

/**
 * The HINTED probe RC1.2 used: it tells the model the tools exist and to use
 * them.
 *
 * Retained so RC1.2's recorded result stays reproducible. RC1.3's un-hinted
 * baseline is the control against it — see
 * `tests/rc13a-live-retrieval.spec.ts`.
 *
 * The questions come from `FACT_PROBES` rather than being retyped, so the probe
 * cannot drift away from the matchers that score it.
 */
const PROBE = [
  'Answer these three questions about our earlier conversation, one line each, no preamble.',
  'If a value is not available, say "unknown" rather than guessing.',
  '',
  'You have context_search and context_recall tools that can read folded history —',
  'use them if the answer is not on the current surface.',
  '',
  ...FACT_PROBES.map(probe => probe.question),
].join('\n')

// Re-exported so the RC1.2 §3 scoring semantics remain pinned by this suite's
// own tests even though the implementation moved to the shared module.
export { scoreAnswer }

describe('RC1.2-A: the supersession check reads assertions, not mentions', () => {
  it('accepts a correct answer that NAMES the superseded value', () => {
    // The defect this pins: the first version penalized any occurrence of `30`,
    // so a correct answer that explained the supersession was scored WRONG. The
    // real run produced exactly that phrasing.
    const correct = '1. Maximum batch size: 64 items. 2. Parser timeout: 90 seconds '
      + '(the 30-second value was explicitly superseded by a correction). 3. PARSE-7741.'
    const scored = scoreAnswer(correct)
    expect(scored.constraint).toBe(true)
    expect(scored.supersession).toBe(true)
    expect(scored.exact).toBe(true)
    expect(scored.total).toBe(3)
  })

  it('still rejects an answer that asserts the OLD value', () => {
    // The family's whole purpose: recalling 30 as current is a failure.
    const stale = '1. 64 items. 2. The parser timeout is 30 seconds. 3. PARSE-7741.'
    const scored = scoreAnswer(stale)
    expect(scored.supersession).toBe(false)
    expect(scored.total).toBe(2)
  })

  it('accepts a bare correct value with no explanation', () => {
    const terse = ['1. 64', '2. 90', '3. PARSE-7741'].join(String.fromCharCode(10))
    expect(scoreAnswer(terse).total).toBe(3)
  })

  it('rejects an answer that only says unknown', () => {
    const nothing = '1. unknown 2. unknown 3. unknown'
    expect(scoreAnswer(nothing).total).toBe(0)
  })

  it('does not let a supersession mention excuse a missing 90', () => {
    // Saying "the 30 was superseded" without giving the new value is not an
    // answer, even though the clause carries a marker.
    const evasive = '1. 64 items. 2. The 30-second value was superseded. 3. PARSE-7741.'
    expect(scoreAnswer(evasive).supersession).toBe(false)
  })

  it('the planted facts match their own matchers', () => {
    // A fixture whose facts do not satisfy the matchers would make every arm
    // score zero for a reason that has nothing to do with EF.
    expect(scoreAnswer(Object.values(FACTS).join(' ')).total).toBe(3)
  })
})

describe.skipIf(!LIVE_ENABLED)('RC1.2-A live: the recall loop actually executes tools', () => {
  it('three arms, real tool execution, bounded rounds', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const SMOKE_WINDOW = Number(process.env.EF_LIVE_SMOKE_WINDOW ?? 6_000)
    const REPLICATES = Number(process.env.EF_LIVE_RECALL_REPLICATES ?? 3)
    const profile = flash()

    // PRODUCTION retention, and identical window/threshold/retain across arms.
    const shared = {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: Math.floor((SMOKE_WINDOW - 1_500) * 0.16),
      maxTokens: 1_500,
    }

    const arms = ['basic', 'none', 'rationale'] as const
    type Arm = (typeof arms)[number]

    const runArm = async (arm: Arm, replicate: number): Promise<{
      outcome: LoopOutcome
      folds: number
      cost: number
      calls: number
      failed: number
    }> => {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: SMOKE_WINDOW,
      })
      const recorder = new BillingRecorder(adapter, `${arm}-${replicate}`)
      // THE ARMS ARE MOUNTED MUTUALLY EXCLUSIVELY (RC1.2.1).
      //
      // The previous version passed `plugin: true` unconditionally and then
      // spread `{ engine: 'basic' }` for the Basic arm. `createHarness` returns
      // early on `plugin: true`, so that spread was DEAD CODE and the "Basic"
      // arm was really EF with the default policy plus the EF recall tools —
      // which is why it reported `facts retrievable 2/5`, a metric that is
      // undefined for real Basic. The harness now throws on that combination,
      // and this builds each arm explicitly.
      //
      // Basic is a different COMPACTION ENGINE, not a plugin configuration: it
      // has no Bundle, and `context_search` / `context_recall` do not exist for
      // it. Mounting the ToolRuntime is still correct — it is what lets a model
      // call whatever tools ARE declared — but the EF tools simply are not
      // among them.
      const harness = await createHarness({ text: 'digest' }, arm === 'basic'
        ? {
          contextWindow: SMOKE_WINDOW,
          engine: 'basic' as const,
          systemPrompt: true,
          tools: true,
          efConfig: shared,
          adapter: { provider: LIVE_PROVIDER, instance: recorder },
        }
        : {
          contextWindow: SMOKE_WINDOW,
          plugin: true,
          systemPrompt: true,
          // The ToolRuntime is what makes `context_search` / `context_recall`
          // executable. RC1.1's smoke omitted it, so the loop could not exist.
          tools: true,
          efConfig: arm === 'rationale'
            ? { ...resolvePreset('economy'), ...shared, semanticMode: 'rationale' as const }
            : { ...resolvePreset('economy'), ...shared },
          adapter: { provider: LIVE_PROVIDER, instance: recorder },
        })
      const session = seedNarrative('rc12')
      const folds = await growAndFold(harness, session, 14, 3_000)
      const outcome = await runRecallLoop(harness, session, PROBE)
      const bill = summarizeFullBill(`${arm}-${replicate}`, recorder.bill, profile)
      return {
        outcome,
        folds,
        cost: bill.cost,
        calls: recorder.bill.length,
        failed: recorder.failedCalls.length,
      }
    }

    const results: Record<Arm, Array<{ outcome: LoopOutcome; folds: number; cost: number; calls: number; failed: number }>> = {
      basic: [], none: [], rationale: [],
    }

    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const arm of arms) {
        const result = await runArm(arm, replicate)
        results[arm].push(result)
        const scored = scoreAnswer(result.outcome.answer)
        console.log(
          `RECALL rep${replicate} ${arm.padEnd(9)}: folds=${result.folds} `
          + `rounds=${result.outcome.rounds} search=${result.outcome.searchCalls} `
          + `recall=${result.outcome.recallCalls} other=${result.outcome.otherCalls} `
          + `recalledChars=${result.outcome.recalledChars} calls=${result.calls} `
          + `failed=${result.failed} cost=${result.cost.toFixed(5)} `
          + `truncated=${result.outcome.truncated} `
          + `answerScore=${JSON.stringify(scored)}`
          + (arm === 'basic'
            ? ''
            : ` toolOutputFacts=${result.outcome.toolOutputFacts.total}/3`),
        )
        console.log(`  answer: ${result.outcome.answer.replace(/\s+/gu, ' ').slice(0, 260)}`)
      }
    }

    // --- Vacuity guard: an arm that never folded measured nothing about folding.
    for (const arm of arms) {
      expect(
        results[arm].every(result => result.folds > 0),
        `${arm} must fold in every replicate`,
      ).toBe(true)
    }

    const mean = (values: readonly number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

    // --- A TRUNCATED loop is excluded from the quality tally, never scored as
    // a wrong answer. R4-E established this: an empty answer caused by the
    // harness running out of rounds is not a policy failure, and counting it as
    // one manufactures a regression.
    const completed: Record<Arm, typeof results.basic> = { basic: [], none: [], rationale: [] }
    for (const arm of arms) {
      for (const result of results[arm]) {
        if (result.outcome.truncated) {
          console.log(
            `EXCLUDED (truncated): ${arm} hit the ${MAX_ROUNDS}-round cap while still calling tools; `
            + 'its answer is incomplete, so it is not a quality observation',
          )
          continue
        }
        completed[arm].push(result)
      }
    }

    // --- The mechanism metric is EF-ONLY. Basic has no Bundle and no EF recall
    // tools, so "facts retrievable through EF recall" is undefined for it, and
    // reporting a number there was the error RC1.2.1 corrected.
    console.log('RETRIEVAL (EF arms only) vs ANSWER (all arms, out of 3 facts):')
    for (const arm of arms) {
      const answered = completed[arm].map(result => scoreAnswer(result.outcome.answer).total)
      if (arm === 'basic') {
        console.log(
          `  ${arm.padEnd(9)} answer [${answered.join(', ')}] | no EF recall tools: `
          + 'retrievability is undefined for Basic',
        )
        continue
      }
      const retrieved = completed[arm].map(result => result.outcome.toolOutputFacts.total)
      console.log(
        `  ${arm.padEnd(9)} tool-returned facts [${retrieved.join(', ')}] | answer [${answered.join(', ')}]`,
      )
    }

    console.log('RECALL SUMMARY (score out of 3, completed loops only):')
    for (const arm of arms) {
      const scores = completed[arm].map(result => scoreAnswer(result.outcome.answer).total)
      const searches = completed[arm].map(result => result.outcome.searchCalls)
      const recalls = completed[arm].map(result => result.outcome.recallCalls)
      console.log(
        `  ${arm.padEnd(9)} n=${scores.length} scores [${scores.join(', ')}] `
        + `mean ${scores.length === 0 ? 'n/a' : mean(scores).toFixed(2)}/3 | `
        + `search [${searches.join(', ')}] recall [${recalls.join(', ')}]`,
      )
    }

    // --- THE QUESTION: does the loop recover what the surface lost?
    const noneScores = completed.none.map(result => scoreAnswer(result.outcome.answer).total)
    const basicScores = completed.basic.map(result => scoreAnswer(result.outcome.answer).total)
    const rationaleScores = completed.rationale.map(result => scoreAnswer(result.outcome.answer).total)
    const noneMean = mean(noneScores)
    const basicMean = mean(basicScores)
    const rationaleMean = mean(rationaleScores)

    const noneSearched = results.none.some(result => result.outcome.searchCalls + result.outcome.recallCalls > 0)
    const noneRecalled = results.none.some(result => result.outcome.recalledChars > 0)

    // A tally over zero completed loops would compare nothing, so it is
    // reported rather than silently producing a 0/3.
    if (noneScores.length === 0 || basicScores.length === 0) {
      console.log(
        'RECALL INCONCLUSIVE: too few completed loops to compare. The round cap is the constraint, '
        + 'not the policy.',
      )
    }

    console.log(
      `RECALL OUTCOME: none ${noneMean.toFixed(2)}/3, basic ${basicMean.toFixed(2)}/3, `
      + `rationale ${rationaleMean.toFixed(2)}/3; none used recall tools: ${noneSearched} `
      + `(returned content: ${noneRecalled})`,
    )

    // --- THE SEPARATION, which is what RC1.2 §3's readings turn on.
    //
    // A run where recall RETURNED the facts and the model then answered badly is
    // not the same finding as a run where recall returned nothing. The first is a
    // model tool-use outcome; the second would be an EF mechanism failure. Only
    // the second would justify changing the preset.
    const efArms = arms.filter(arm => arm !== 'basic')
    const retrieved = (arm: Arm): number[] =>
      completed[arm].map(result => result.outcome.toolOutputFacts.total)
    const mechanismRecovered = efArms.map(arm => ({
      arm,
      runs: retrieved(arm).length,
      recovered: retrieved(arm).filter(score => score > 0).length,
      best: retrieved(arm).length === 0 ? 0 : Math.max(...retrieved(arm)),
    }))
    for (const entry of mechanismRecovered) {
      console.log(
        `RECALL MECHANISM ${entry.arm.padEnd(9)}: a tool returned facts in `
        + `${entry.recovered}/${entry.runs} completed run(s); best ${entry.best}/3`,
      )
    }

    // --- RC1.2 §3's readings, stated explicitly so the report cannot pick a
    // flattering one afterwards.
    const mechanismWorks = mechanismRecovered.every(entry => entry.recovered > 0)
    if (noneScores.length === 0 || basicScores.length === 0) {
      console.log('RC1.2 INCONCLUSIVE: too few completed loops to compare.')
    } else if (noneMean >= basicMean) {
      console.log(
        'RC1.2 OUTCOME A: economy-none matches Basic once recall is available. The RC1.1 '
        + '"conditional on declaration" reading was TOO STRONG; the contract is "declared state is '
        + 'hot, undeclared history is recoverable through bounded recall".',
      )
    } else if (mechanismWorks) {
      // The distinction that decides whether the preset is at fault.
      console.log(
        'RC1.2 OUTCOME A (mechanism works, residual gap is tool use): recall RETURNS the folded facts in every arm, and the residual '
        + 'answer-score gap is MODEL TOOL USE, not the EF mechanism. A generic economy preset is '
        + 'not shown to need rationale by this evidence — the mechanism it relies on works.',
      )
    } else {
      console.log(
        'RC1.2 OUTCOME B/C: recall did not return the facts in at least one arm. That is a mechanism '
        + 'finding and would justify changing the preset; it needs a larger sample to confirm.',
      )
    }

    // The assertion records the OUTCOME rather than a pass/fail on a policy: all
    // three are legitimate findings, and the test's job is to establish which.
    expect(noneScores.length).toBe(REPLICATES)
    expect(basicScores.length).toBe(REPLICATES)
    // Whatever the outcome, the loop must have been genuinely available to the
    // economy arm — otherwise the result describes the harness, not the policy.
    expect(
      results.none.every(result => result.outcome.providerCalls > 0),
      'the economy arm must have made model calls',
    ).toBe(true)
  }, 2_400_000)
})
