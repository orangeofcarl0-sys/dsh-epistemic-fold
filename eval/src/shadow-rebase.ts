/**
 * RC1-C: shadow root telemetry — is the fixed budget suppressing profitable
 * rebases?
 *
 * RC0 measured `0 roots` across 15 live runs and it was easy to read that as a
 * defect. RC1 §17 says it is not automatically one: a marker-only checkpoint
 * costs about 30 tokens, and if carrying it is cheap then NOT rebasing is
 * exactly what an economic policy should do. The question is not "did a root
 * happen?" but:
 *
 *   did the ECONOMICS ever want one while the fixed budget blocked it?
 *
 * That question is answerable without changing behavior. After each leaf, the
 * shadow evaluator asks the production decision function what it would do if
 * the budget gate did not exist, and records the answer. Nothing executes.
 *
 * **Profitability and the pressure override are counted separately, and the
 * distinction is load-bearing.** `compileContextPolicy` returns `root` for two
 * different reasons: economics judged the rebase repayable within the horizon
 * (`overridden: false`, `breakEvenRequests` set), or a hard override fired
 * because pressure crossed the threshold (`overridden: true`). The first is
 * what §19 means by "profitable". The second is not a statement about
 * economics at all — and a shadow evaluator that conflated them reported
 * "135 of 135 evaluations want a rebase" on a regime where the leaf fold was
 * demonstrably handling the pressure, which is a manufactured signal rather
 * than a measurement.
 *
 * So `economicallyProfitable` is derived from the break-even horizon, and the
 * override is reported alongside it as a separate fact.
 *
 * The gate is then trivially readable (RC1 §19):
 *
 *   profitable-but-blocked == 0   → the 24000 budget is not hurting this
 *                                   regime; do not change it
 *   profitable-but-blocked > 0    → the budget is the wrong gate, and only
 *                                   THEN is adjusting the evaluation
 *                                   threshold worth discussing
 *
 * Note the asymmetry the design preserves: adjusting how often a root is
 * EVALUATED is not the same as forcing one to execute. The shadow pass only
 * widens observation.
 *
 * @module eval/src/shadow-rebase
 */

import type { ContextPolicyDecision } from '../../src/policy-compiler.ts'

/** One shadow evaluation, made after a leaf fold. */
export interface ShadowSample {
  readonly step: number
  /** Frozen-prefix tokens at the moment of evaluation. */
  readonly frozenTokens: number
  readonly frozenCount: number
  /** Whether the configured frozen budget gate would have allowed a rebase. */
  readonly budgetGateOpen: boolean
  /** What the production decision function returned, ignoring that gate. */
  readonly decision: ContextPolicyDecision
  /**
   * Whether ECONOMICS judged the rebase repayable — `breakEvenRequests` within
   * the policy horizon. Independent of any override.
   */
  readonly economicallyProfitable: boolean
  /**
   * Whether a hard override produced the action instead of economics. Recorded
   * so a report can show the two claims side by side rather than summing them.
   */
  readonly pressureOverridden: boolean
}

/** The gate RC1 §19 states, computed from the samples. */
export interface ShadowVerdict {
  readonly samples: number
  /** Samples where economics alone wanted a rebase. */
  readonly profitable: number
  /** Of those, how many the budget gate blocked. */
  readonly profitableButBlocked: number
  /**
   * Samples whose action came from a hard override rather than economics.
   * Reported separately because it is NOT evidence about the budget.
   */
  readonly overridden: number
  /**
   * Whether the fixed budget is hurting this regime. `false` when nothing
   * profitable was suppressed, which RC1 §19 treats as "do not change it".
   */
  readonly budgetIsHarming: boolean
  /**
   * Whether the profitability claim rests on a ZERO rebase cost.
   *
   * When it does, `profitable` is not evidence: with `compactionCost = 0` the
   * break-even horizon is 0 for ANY frozen load, so the economics says "rebase"
   * even when the prefix costs 580 tokens. That is arithmetic about a free
   * action, not a finding about this regime — and it is exactly how a shadow
   * evaluator manufactures a budget indictment out of nothing.
   */
  readonly costDegenerate: boolean
  /** `harming` | `exonerated` | `inconclusive` — three states, not two. */
  readonly verdict: 'harming' | 'exonerated' | 'inconclusive'
  readonly reason: string
}

/**
 * Summarize shadow samples into the RC1-C verdict.
 *
 * @param samples - the shadow evaluations.
 * @param options - the rebase cost the evaluations used. Zero makes the
 *   profitability claim vacuous, and the verdict says `inconclusive` rather
 *   than indicting the budget on it.
 * @returns the counts and the verdict.
 */
export function summarizeShadow(
  samples: readonly ShadowSample[],
  options: { readonly compactionCost?: number } = {},
): ShadowVerdict {
  const compactionCost = options.compactionCost ?? 0
  const costDegenerate = compactionCost <= 0
  const profitableSamples = samples.filter(sample => sample.economicallyProfitable)
  const blocked = profitableSamples.filter(sample => !sample.budgetGateOpen)
  const overridden = samples.filter(sample => sample.pressureOverridden).length
  const counts = {
    samples: samples.length,
    profitable: profitableSamples.length,
    profitableButBlocked: blocked.length,
    overridden,
    costDegenerate,
  }

  // A zero-cost model makes "profitable" true for any frozen load, so a
  // suppression count computed from it is not a measurement of anything. The
  // budget is neither exonerated (something WAS suppressed) nor indicted (the
  // suppression rests on a degenerate assumption).
  if (costDegenerate && blocked.length > 0) {
    return {
      ...counts,
      budgetIsHarming: false,
      verdict: 'inconclusive',
      reason: `${blocked.length} of ${samples.length} shadow evaluations would rebase and the budget `
        + 'blocked them — but the rebase cost model is ZERO, so the break-even horizon is 0 for any '
        + 'frozen load and profitability is vacuous. This is not evidence against the budget; it is '
        + 'evidence that `compactionCost` must be set before the question can be asked',
    }
  }
  if (blocked.length > 0) {
    return {
      ...counts,
      budgetIsHarming: true,
      verdict: 'harming',
      reason: `${blocked.length} of ${samples.length} shadow evaluations were economically profitable `
        + 'at a modeled rebase cost and the fixed frozen budget blocked them; the budget gate is '
        + 'suppressing admissible rebases',
    }
  }
  return {
    ...counts,
    budgetIsHarming: false,
    verdict: 'exonerated',
    reason: `${profitableSamples.length} of ${samples.length} shadow evaluations were economically `
      + `profitable, and none was blocked by the fixed budget (${overridden} action(s) came from a `
      + 'pressure override instead); the budget is not hurting this regime, so it should not be '
      + 'changed on this evidence',
  }
}

/**
 * Whether one production decision was economically profitable.
 *
 * The compiler populates `breakEvenRequests` on both the `root` and `none`
 * paths, so this reads the horizon comparison directly rather than inferring it
 * from the action — which is what keeps a pressure override from being counted
 * as an economic judgement.
 *
 * @param decision - the production decision.
 * @param paybackHorizonRequests - the policy's horizon.
 * @returns true when the rebase pays back inside the horizon.
 */
export function isEconomicallyProfitable(
  decision: ContextPolicyDecision,
  paybackHorizonRequests: number,
): boolean {
  return decision.breakEvenRequests !== undefined
    && decision.breakEvenRequests <= paybackHorizonRequests
}

/** Render the shadow verdict as Markdown for a report. */
export function shadowToMarkdown(verdict: ShadowVerdict): string {
  return [
    `- Shadow evaluations: **${verdict.samples}**`,
    `- Economically profitable: **${verdict.profitable}**`,
    `- Profitable but budget-blocked: **${verdict.profitableButBlocked}**`,
    `- Action from a pressure override: **${verdict.overridden}** (not evidence about the budget)`,
    `- Rebase cost model degenerate: **${verdict.costDegenerate ? 'yes' : 'no'}**`,
    `- Verdict: **${verdict.verdict}**`,
    `- ${verdict.reason}`,
  ].join('\n')
}
