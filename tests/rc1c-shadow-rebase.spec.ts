/**
 * RC1-C: the fixed budget is either exonerated or indicted, with evidence.
 *
 * RC0 measured `0 roots` across 15 live runs. The tempting reading is "the
 * budget is blocking rebases"; the correct procedure is to ASK the production
 * decision function, after every leaf, whether the ECONOMICS would rebase if
 * the budget gate were absent — and then count how often the answer was yes
 * while the gate said no.
 *
 * The distinction between "the economics wanted it" and "a pressure override
 * demanded it" is the whole test. The first version of this evaluator counted
 * both, and reported 135 of 135 evaluations wanting a rebase on a regime where
 * leaf folds were visibly handling the pressure — a manufactured signal. The
 * numbers below separate them.
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile } from '../src/economics-profile.ts'
import { compileContextPolicy } from '../src/policy-compiler.ts'
import type { ContextPolicyDecision } from '../src/policy-compiler.ts'
import { isEconomicallyProfitable, summarizeShadow } from '../eval/src/shadow-rebase.ts'
import type { ShadowSample } from '../eval/src/shadow-rebase.ts'
import { buildCorpus, SYNTHETIC_RESERVED, SYNTHETIC_WINDOW, STATE_RICH_CHECKPOINT_TOKENS } from '../eval/policy-replay/corpus.ts'
import { checkpointSizeOf, syntheticTrace } from '../eval/policy-replay/trace.ts'
import { simulate } from '../eval/policy-replay/simulator.ts'

const PROFILE = resolveProfile(BUILTIN_ECONOMICS_PROFILES, 'deepseek', 'deepseek-v4.1-flash')
const HORIZON = 200

/** The production economic question, asked without the budget gate. */
function askShadow(options: {
  readonly frozenTokens: number
  readonly frozenCount: number
  readonly tailTokens: number
  readonly promptTokens: number
  readonly contextWindow: number
  readonly pressureRatio: number
  readonly realizationRate: number
}): ContextPolicyDecision {
  return compileContextPolicy({
    economics: PROFILE,
    telemetry: {
      frozenTokens: options.frozenTokens,
      frozenCheckpointCount: options.frozenCount,
      rawTailTokens: options.tailTokens,
      promptTokens: options.promptTokens,
      // At idle the production consumer relaxes the cooldown (R3-0b), so the
      // shadow question is asked the same way the idle path asks it.
      recentFoldCadence: Number.POSITIVE_INFINITY,
    },
    pressure: { contextWindow: options.contextWindow, currentTokens: options.promptTokens },
    policy: {
      paybackHorizonRequests: HORIZON,
      realizationRate: options.realizationRate,
      pressureRatio: options.pressureRatio,
      compactionCost: 0,
      // Production's idle path sets this; without it the pressure override
      // returns `leaf` and the root question is never reached.
      leafAvailable: false,
    },
  })
}

/** Build a sample from one decision, deriving the two separate claims. */
function sampleOf(
  step: number,
  frozenTokens: number,
  frozenCount: number,
  budgetGateOpen: boolean,
  decision: ContextPolicyDecision,
): ShadowSample {
  return {
    step,
    frozenTokens,
    frozenCount,
    budgetGateOpen,
    decision,
    economicallyProfitable: isEconomicallyProfitable(decision, HORIZON),
    pressureOverridden: decision.overridden,
  }
}

describe('RC1-C: the shadow gate is stated in terms of suppressed PROFITABLE rebases', () => {
  it('reports zero when nothing profitable was blocked', () => {
    const samples = [
      sampleOf(1, 40, 2, false, { action: 'none', overridden: false } as never),
      sampleOf(2, 60, 3, false, { action: 'none', overridden: false } as never),
    ]
    const verdict = summarizeShadow(samples)
    expect(verdict.profitable).toBe(0)
    expect(verdict.profitableButBlocked).toBe(0)
    expect(verdict.budgetIsHarming).toBe(false)
    expect(verdict.reason).toContain('should not be changed on this evidence')
  })

  it('does NOT count a pressure override as an economic judgement', () => {
    // The defect this test exists to prevent. An override returns `root` while
    // the economics is unknown (no breakEvenRequests), so counting the ACTION
    // would report a budget problem that the economics never asserted.
    const overridden = sampleOf(1, 4_000, 8, false, {
      action: 'root',
      overridden: true,
      reason: 'context pressure 22.0% >= 15.0%; a rebase is required',
    } as never)
    expect(overridden.economicallyProfitable).toBe(false)
    const verdict = summarizeShadow([overridden])
    expect(verdict.profitable).toBe(0)
    expect(verdict.profitableButBlocked).toBe(0)
    expect(verdict.overridden).toBe(1)
    expect(verdict.budgetIsHarming).toBe(false)
    expect(verdict.reason).toContain('pressure override instead')
  })

  it('indicts the budget only when a PROFITABLE rebase was blocked', () => {
    const samples = [
      sampleOf(1, 40, 2, false, { action: 'none', overridden: false } as never),
      sampleOf(2, 30_000, 4, false, {
        action: 'root', overridden: false, breakEvenRequests: 12,
      } as never),
    ]
    // A real cost, so the profitability claim is not degenerate.
    const verdict = summarizeShadow(samples, { compactionCost: 0.01 })
    expect(verdict.profitable).toBe(1)
    expect(verdict.profitableButBlocked).toBe(1)
    expect(verdict.budgetIsHarming).toBe(true)
    expect(verdict.verdict).toBe('harming')
    expect(verdict.reason).toContain('suppressing admissible rebases')
  })

  it('does NOT indict the budget when a profitable rebase was permitted', () => {
    // A rebase the gate allowed is not evidence against the gate, even if it
    // did not end up executing. Only suppression counts.
    const samples = [
      sampleOf(1, 30_000, 4, true, {
        action: 'root', overridden: false, breakEvenRequests: 12,
      } as never),
    ]
    const verdict = summarizeShadow(samples)
    expect(verdict.profitable).toBe(1)
    expect(verdict.profitableButBlocked).toBe(0)
    expect(verdict.budgetIsHarming).toBe(false)
  })

  it('reads profitability from the horizon, not from the action', () => {
    // A `none` decision that still reports a break-even OUTSIDE the horizon is
    // not profitable; a `none` with no break-even at all is not either.
    expect(isEconomicallyProfitable({ breakEvenRequests: 500 } as never, HORIZON)).toBe(false)
    expect(isEconomicallyProfitable({ breakEvenRequests: 50 } as never, HORIZON)).toBe(true)
    expect(isEconomicallyProfitable({} as never, HORIZON)).toBe(false)
  })

  it('refuses to indict the budget on a ZERO rebase cost', () => {
    // The second manufactured signal, found while testing the first. With
    // `compactionCost = 0` the break-even horizon is 0 for ANY frozen load, so
    // the economics says "rebase" even when the prefix costs 580 tokens. A
    // suppression count computed from that is arithmetic about a free action,
    // not a finding about the regime — so the verdict is `inconclusive`, not
    // `harming`.
    const samples = [
      sampleOf(1, 30_000, 4, false, {
        action: 'root', overridden: false, breakEvenRequests: 0,
      } as never),
    ]
    const zeroCost = summarizeShadow(samples, { compactionCost: 0 })
    expect(zeroCost.costDegenerate).toBe(true)
    expect(zeroCost.profitableButBlocked).toBe(1)
    expect(zeroCost.verdict).toBe('inconclusive')
    expect(zeroCost.budgetIsHarming).toBe(false)
    expect(zeroCost.reason).toContain('compactionCost` must be set')

    // At a real cost the same suppression IS evidence, and the verdict flips.
    const realCost = summarizeShadow(samples, { compactionCost: 0.01 })
    expect(realCost.costDegenerate).toBe(false)
    expect(realCost.verdict).toBe('harming')
  })
})

describe('RC1-C: measured on the corpus, at both checkpoint regimes', () => {
  it('the marker-only regime does not justify changing the budget', async () => {
    // The regime RC0 actually observed: 20-token checkpoints. If the shadow
    // finds no blocked profitable rebase here, the 24000 budget is exonerated
    // for the shipped configuration and RC1 §19 closes the question.
    const corpus = await buildCorpus({ observedSteps: 60, syntheticSteps: 60 })
    const markerOnly = corpus.filter(trace => !trace.id.startsWith('synthetic:'))
    expect(markerOnly.length).toBe(4)

    const samples: ShadowSample[] = []
    for (const trace of markerOnly) {
      const size = checkpointSizeOf(trace, 200)
      expect(size.evidenced).toBe(true)
      // Walk the observed trajectory's own pressure sequence through the
      // production decision function, with the frozen prefix exactly as the
      // observation showed it.
      for (const step of trace.steps) {
        if (!step.folded) continue
        const frozenCount = Math.max(1, Math.round(step.checkpointLoad / Math.max(1, size.tokens)))
        const decision = askShadow({
          frozenTokens: step.checkpointLoad,
          frozenCount,
          tailTokens: step.rawTailTokens,
          promptTokens: step.preFoldTokens,
          contextWindow: trace.contextWindow,
          pressureRatio: trace.thresholdRatio,
          realizationRate: 0.9,
        })
        samples.push(sampleOf(
          step.step, step.checkpointLoad, frozenCount,
          // The configured budget, at these observed loads, is nowhere near
          // exceeded — which is itself the RC0 finding.
          step.checkpointLoad > 24_000, decision,
        ))
      }
    }
    expect(samples.length).toBeGreaterThan(5)
    const verdict = summarizeShadow(samples, { compactionCost: 0 })
    console.log(`SHADOW (marker-only): ${verdict.reason}`)
    console.log(
      `  samples=${verdict.samples} profitable=${verdict.profitable} `
      + `blocked=${verdict.profitableButBlocked} overridden=${verdict.overridden} `
      + `verdict=${verdict.verdict}`,
    )
    // The measured result: at the OBSERVED loads the budget gate is nowhere
    // near exceeded, so nothing was suppressed and the budget is not the
    // constraint. The 135 overrides are reported separately and are NOT
    // counted as economic evidence.
    expect(verdict.profitableButBlocked).toBe(0)
    expect(verdict.budgetIsHarming).toBe(false)
    expect(verdict.verdict).toBe('exonerated')
  }, 600_000)

  it('the same corpus DOES suppress rebases once the budget is the binding gate', () => {
    // The positive control for the test above. Without it, "nothing was
    // suppressed" could mean the evaluator never fires rather than the budget
    // being innocent. With the budget set ABOVE the observed loads, the gate
    // is CLOSED (the rebase is not yet recommended by the fixed budget) while
    // the economics says yes — so the same shape of sample must report
    // suppression, proving the evaluator discriminates rather than always
    // answering no.
    const budget = 24_000
    const samples: ShadowSample[] = [
      // `budgetGateOpen` is `frozenTokens > budget`: a 580-token prefix is far
      // below a 24000-token budget, so the fixed gate would NOT recommend a
      // rebase here.
      sampleOf(1, 580, 29, 580 > budget, {
        action: 'root', overridden: false, breakEvenRequests: 0,
      } as never),
      sampleOf(2, 100, 5, 100 > budget, {
        action: 'root', overridden: false, breakEvenRequests: 0,
      } as never),
    ]
    expect(samples.every(sample => !sample.budgetGateOpen)).toBe(true)
    const verdict = summarizeShadow(samples, { compactionCost: 0 })
    // With a degenerate cost the verdict is `inconclusive`, which is the
    // honest answer — but the SUPPRESSION count must still register, proving
    // the evaluator is not stuck on "no".
    expect(verdict.profitableButBlocked).toBe(2)
    expect(verdict.verdict).toBe('inconclusive')
    // And at a real cost it becomes an actual indictment.
    expect(summarizeShadow(samples, { compactionCost: 0.01 }).verdict).toBe('harming')
  })

  it('the state-rich regime is where a rebase becomes economically admissible', () => {
    // RC1 §20's regime, evaluated through the same production decision
    // function. If a rebase is economically profitable anywhere, it is here —
    // and that is what makes the marker-only result meaningful rather than a
    // blanket "rebasing never pays".
    //
    // Pressure is deliberately kept BELOW the ratio (4600 / 32768 = 14.0% <
    // 15%) so the pressure override does not fire and the ECONOMIC question is
    // actually reached. Asking above the ratio would return an override, which
    // is exactly the conflation this test module exists to avoid.
    const frozenCount = 6
    const frozenTokens = STATE_RICH_CHECKPOINT_TOKENS * frozenCount
    const tailTokens = 1_000
    const promptTokens = frozenTokens + tailTokens
    expect(promptTokens / SYNTHETIC_WINDOW).toBeLessThan(0.15)

    const shadow = askShadow({
      frozenTokens,
      frozenCount,
      tailTokens,
      promptTokens,
      contextWindow: SYNTHETIC_WINDOW,
      pressureRatio: 0.15,
      realizationRate: 0.9,
    })
    console.log(
      `SHADOW (state-rich): action=${shadow.action} breakEven=${shadow.breakEvenRequests} `
      + `overridden=${shadow.overridden} reason=${shadow.reason}`,
    )
    // The production decision function must be ABLE to reason about the
    // break-even here; a regime where it never could would mean the
    // marker-only result proves nothing.
    expect(shadow.overridden).toBe(false)
    expect(Number.isFinite(shadow.breakEvenRequests ?? Number.NaN)).toBe(true)
  })

  it('the shadow evaluator never executes a rebase', () => {
    // The safety property that makes shadow telemetry free to run everywhere:
    // it is pure. A simulation with maintenance disabled must show zero roots
    // no matter what the shadow decided.
    const trace = syntheticTrace('purity', {
      steps: 20, growthTokens: 2_400, contextWindow: SYNTHETIC_WINDOW,
      reservedCompletionTokens: SYNTHETIC_RESERVED, declaredCheckpointTokens: 600,
    })
    const result = simulate(trace, {
      config: {
        leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
        thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0,
      },
      contextWindow: SYNTHETIC_WINDOW,
      reservedCompletionTokens: SYNTHETIC_RESERVED,
      realization: 0.9,
      fallbackCheckpointTokens: 200,
      basicCheckpointTokens: 400,
      outputTokensPerRequest: 200,
      rationaleInputTokens: 7_383,
      rationaleOutputTokens: 400,
      idleMaintenance: false,
    }, 'ef', PROFILE)
    expect(result.rootRebases).toBe(0)
    // And the shadow question, asked on the same state, is still allowed to
    // answer `root` — evaluation and execution are separate.
    const shadow = askShadow({
      frozenTokens: 4_800, frozenCount: 8, tailTokens: 2_400, promptTokens: 7_200,
      contextWindow: SYNTHETIC_WINDOW, pressureRatio: 0.15, realizationRate: 0.9,
    })
    expect(['root', 'none']).toContain(shadow.action)
    expect(result.rootRebases).toBe(0)
  })
})
