/**
 * RC1.3 live: the UN-HINTED retrieval baseline, and where the chain breaks.
 *
 * RC1.2's probe told the model the recall tools existed and to use them. That
 * measured the mechanism under a favourable instruction, which is not the same
 * as what a deployment gets: a real user does not tell the agent how to use its
 * own tools. So the baseline probe here asks the questions and says NOTHING
 * about retrieval, and the hinted probe is kept as the control. The difference
 * between them is the measured value of the hint — which is exactly what RC1.3
 * §3 says to only add if it is needed.
 *
 * A score alone would not be actionable, so every completed run is classified by
 * `eval/src/retrieval-taxonomy.ts`: which LINK of the chain broke, for each fact.
 * The taxonomy decides the next change, and RC1.3's rule is one change at a
 * time so the effect stays attributable — so the run reports the recommended
 * action rather than applying it.
 *
 * @module tests/rc13a-live-retrieval
 */

import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.ts'
import {
  assemble,
  FACTS,
  FACT_PROBES,
  factsOnSurface,
  filler,
  growAndFold,
  MAX_ROUNDS,
  runRecallLoop,
  scoreFacts,
  seedNarrative,
} from './recall-loop.ts'
import type { FactProbe, LoopOutcome } from './recall-loop.ts'
import { classifyRun, recommendedAction, summarizeTaxonomy } from '../eval/src/retrieval-taxonomy.ts'
import type { FactTrace, RunVerdict } from '../eval/src/retrieval-taxonomy.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { BillingRecorder } from '../eval/live/recorder.ts'
import { summarizeFullBill } from '../eval/live/billing.ts'
import { flash } from './economics-fixture.ts'
import { resolvePreset } from '../src/preset.ts'
import { FOLD_FRAMING_SECTION } from '../src/framing.ts'
import { LIVE_ENABLED, LIVE_PROVIDER } from './live-gate.ts'


/**
 * The UN-HINTED probe: the baseline a real deployment actually faces.
 *
 * It states the task and nothing about how to accomplish it. If the model
 * searches, it did so because the tool schemas and the framing section led it
 * there — not because the user said to.
 */
export const PROBE_UNHINTED = [
  'Answer these three questions about our earlier conversation, one line each, no preamble.',
  'If a value is not available, say "unknown" rather than guessing.',
  '',
  ...FACT_PROBES.map(probe => probe.question),
].join('\n')

/**
 * The HINTED probe: RC1.2's control.
 *
 * Kept so the value of the hint is measured rather than assumed. If the two
 * arms score the same, the hint buys nothing and RC1.3 §3's instruction must NOT
 * be added — a stable rule that changes no behavior is pure prefix cost.
 */
export const PROBE_HINTED = [
  'Answer these three questions about our earlier conversation, one line each, no preamble.',
  'If a value is not available, say "unknown" rather than guessing.',
  '',
  'You have context_search and context_recall tools that can read folded history —',
  'use them if the answer is not on the current surface.',
  '',
  ...FACT_PROBES.map(probe => probe.question),
].join('\n')

/** One completed run, with its verdict. */
export interface RetrievalRun {
  readonly arm: Arm
  readonly replicate: number
  readonly outcome: LoopOutcome
  readonly folds: number
  readonly verdict: RunVerdict
  /**
   * Whether the facts had actually LEFT the surface before the probe ran.
   *
   * The premise of the whole measurement. A run whose facts are still visible
   * cannot support any conclusion about retrieval: answering them required
   * reading, not recalling, and a `no-search` label on such a run describes a
   * reading failure. The legacy framing arm folds fewer times, so this is
   * checked rather than assumed.
   */
  readonly factsStillOnSurface: Map<string, boolean>
  readonly cost: number
  readonly calls: number
  readonly failed: number
}

/**
 * The arms, as a configuration rather than a name.
 *
 * `unhinted-legacy` is the ATTRIBUTION control. The shipped economy preset
 * mounts `FOLD_FRAMING_SECTION`, whose last sentence already says "Call
 * context_recall with `cp:<id>` when exact folded history is needed" — so the
 * un-hinted probe is not free of retrieval affordances: the framing section is
 * one, and the declared tool schemas are another. Without an arm that removes
 * the framing section, a 3/3 un-hinted result could not distinguish "the model
 * retrieves on its own" from "the shipped system prompt told it to", and RC1.3
 * §3's decision — add a stable instruction or not — would rest on an
 * unmeasured premise.
 */
export type Arm = 'unhinted' | 'hinted' | 'unhinted-legacy'

export interface ArmSpec {
  readonly probe: string
  readonly framingMode: 'system-dedup' | 'legacy'
  /** Whether the shipped EF framing section should appear in the system prompt. */
  readonly expectsFramingSection: boolean
}

export const ARM_SPECS: Readonly<Record<Arm, ArmSpec>> = {
  unhinted: { probe: PROBE_UNHINTED, framingMode: 'system-dedup', expectsFramingSection: true },
  hinted: { probe: PROBE_HINTED, framingMode: 'system-dedup', expectsFramingSection: true },
  'unhinted-legacy': { probe: PROBE_UNHINTED, framingMode: 'legacy', expectsFramingSection: false },
}

/** The sentence in `FOLD_FRAMING_SECTION` that names the recall affordance. */
const FRAMING_RECALL_SENTENCE = 'Call context_recall with `cp:<id>`'

/**
 * The RC1.3 retrieval rule, added to the framing section after the n=9 baseline.
 *
 * Pinned as a literal so a later edit cannot quietly drop the behavior the
 * measurement showed was the only failure mode.
 */
const RETRIEVAL_RULE = 'search the folded history with context_search before answering'

/**
 * Build one fact's trace from what the loop observed.
 *
 * `searchHitRelevant` and `recallRelevant` are read from the TWO tools'
 * separate outputs. That separation is what keeps `recall-miss` reachable: a
 * search excerpt that mentions the fact is available to the model and so counts
 * as returned, while a recall that comes back empty is still a recall miss.
 */
export function traceFor(outcome: LoopOutcome, probe: FactProbe): FactTrace {
  return {
    answerCarries: probe.present(outcome.answer),
    searched: outcome.searchCalls > 0,
    searchHitRelevant: outcome.searchCalls > 0 && probe.present(outcome.searchOutput),
    recalled: outcome.recallCalls > 0,
    recallRelevant: outcome.recallCalls > 0 && probe.present(outcome.recallOutput),
  }
}

/** Classify one run's whole chain. */
export function verdictFor(outcome: LoopOutcome): RunVerdict {
  const traces = new Map<string, FactTrace>(
    FACT_PROBES.map(probe => [probe.id, traceFor(outcome, probe)]),
  )
  return classifyRun(traces)
}

describe('RC1.3: the probe text does not leak the tool names', () => {
  it('the un-hinted probe never names a recall tool', () => {
    // The whole value of this arm is that the model was not told. A probe that
    // leaked `context_search` would silently become a second hinted arm and the
    // baseline would measure nothing.
    expect(PROBE_UNHINTED).not.toContain('context_search')
    expect(PROBE_UNHINTED).not.toContain('context_recall')
    expect(PROBE_UNHINTED).not.toContain('folded history')
  })

  it('the hinted probe does name them, so the two arms differ', () => {
    expect(PROBE_HINTED).toContain('context_search')
    expect(PROBE_HINTED).toContain('context_recall')
  })

  it('both probes ask the same three questions', () => {
    for (const probe of FACT_PROBES) {
      expect(PROBE_UNHINTED).toContain(probe.question)
      expect(PROBE_HINTED).toContain(probe.question)
    }
  })
})

describe('RC1.3: a trace is read from the tool outputs, not guessed', () => {
  const outcome = (overrides: Partial<LoopOutcome>): LoopOutcome => ({
    answer: '',
    rounds: 1,
    searchCalls: 0,
    recallCalls: 0,
    otherCalls: 0,
    recalledChars: 0,
    toolOutputFacts: { constraint: false, supersession: false, exact: false, total: 0 },
    searchOutput: '',
    recallOutput: '',
    toolSteps: [],
    providerCalls: 1,
    truncated: false,
    ...overrides,
  })
  const batch = FACT_PROBES[0]!

  it('reports no-search when no tool ran', () => {
    expect(traceFor(outcome({}), batch)).toMatchObject({ searched: false, recalled: false })
  })

  it('separates a search hit from a recall return', () => {
    const trace = traceFor(outcome({
      searchCalls: 1,
      recallCalls: 1,
      searchOutput: 'excerpt: maximum batch size is 64 items',
      recallOutput: 'page: nothing relevant',
    }), batch)
    expect(trace.searchHitRelevant).toBe(true)
    expect(trace.recallRelevant).toBe(false)
    // The fact WAS available via the excerpt, so this is not a recall miss.
    expect(classifyRun(new Map([['constraint', trace]])).primary)
      .toBe('recall-returned-fact-but-answer-missed')
  })

  it('reports a recall miss when neither tool returned the fact', () => {
    const trace = traceFor(outcome({
      searchCalls: 1,
      recallCalls: 1,
      searchOutput: 'no hits',
      recallOutput: 'page: unrelated',
    }), batch)
    expect(classifyRun(new Map([['constraint', trace]])).primary).toBe('recall-miss')
  })

  it('does not credit a tool output the loop never requested', () => {
    // `searchOutput` carrying text without a search call would be a harness bug;
    // the guard means such a run still classifies as no-search rather than
    // silently counting as a hit.
    const trace = traceFor(outcome({ searchOutput: 'the batch size is 64' }), batch)
    expect(trace.searchHitRelevant).toBe(false)
    expect(classifyRun(new Map([['constraint', trace]])).primary).toBe('no-search')
  })

  it('scores the answer with the same matchers the probe asks with', () => {
    const facts = scoreFacts('1. 64 items. 2. 90 seconds. 3. PARSE-7741.')
    expect(facts.get('constraint')).toBe(true)
    expect(facts.get('supersession')).toBe(true)
    expect(facts.get('exact')).toBe(true)
  })
})

describe('RC1.3: the retrieval rule is present and cache-stable', () => {
  it('the framing section carries the retrieval rule', () => {
    expect(FOLD_FRAMING_SECTION).toContain(RETRIEVAL_RULE)
    // It must say WHEN to search, or it is an instruction with no trigger and
    // the model has no condition to act on.
    expect(FOLD_FRAMING_SECTION).toContain('does not carry information you need')
    // It must also cover the "unknown" path, which is precisely where the
    // measured failures occurred: the model reported unknown without looking.
    expect(FOLD_FRAMING_SECTION).toContain('before reporting that something is unknown')
  })

  it('the rule does not name the hint the baseline removed', () => {
    // The rule is a FRAMING statement, not a restatement of the probe. If it
    // grew a "you have tools" sentence it would duplicate the tool schemas,
    // which the model already receives, and would stop being the minimal change
    // the taxonomy called for.
    expect(FOLD_FRAMING_SECTION).not.toContain('You have context_search')
  })
})

describe('RC1.3: the fixture cannot satisfy its own fact matchers', () => {
  it('filler text contains no fact token', () => {
    // The defect this pins: the filler's unit index was a DECIMAL number, so
    // `unit 64`, `unit 90` and `unit 30` appeared in retained filler — the exact
    // tokens the matchers search for. A run could then score a point by reading
    // a unit index, and the "facts left the surface" premise could never hold.
    const text = `${filler('background', 400)} ${filler('step 2', 250)}`
    const scored = scoreFacts(text)
    for (const probe of FACT_PROBES) {
      expect(
        scored.get(probe.id),
        `filler must not satisfy the ${probe.id} matcher`,
      ).toBe(false)
    }
  })

  it('the planted facts do satisfy their matchers', () => {
    // The converse guard: a fixture whose facts do not match would make every
    // arm score zero for a reason unrelated to retrieval.
    const planted = `${FACTS.constraint} ${FACTS.superseded} ${FACTS.supersession} ${FACTS.exact}`
    const scored = scoreFacts(planted)
    for (const probe of FACT_PROBES) {
      expect(scored.get(probe.id), `${probe.id} must be satisfied by the planted facts`).toBe(true)
    }
  })

  it('the letters helper never emits a digit', () => {
    const text = filler('x', 800)
    expect(/\d/u.test(text)).toBe(false)
  })
})

describe('RC1.3: the attribution premise is real, not assumed', () => {
  it('the shipped economy framing section names the recall affordance', async () => {
    // The un-hinted arm is only "un-hinted" by the PROBE. The shipped system
    // prompt still carries `FOLD_FRAMING_SECTION`, whose last sentence tells the
    // model to call context_recall. This test pins that fact, so the report
    // cannot describe the un-hinted arm as free of retrieval affordances.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 6_000,
      plugin: true,
      systemPrompt: true,
      efConfig: {
        ...resolvePreset('economy'),
        thresholdRatio: 0.15,
        headroomTokens: 0,
        retainTokens: 700,
        maxTokens: 1_500,
      },
    })
    const { system } = await assemble(harness)
    expect(system, 'the system prompt must be assembled').toBeTypeOf('string')
    expect(system).toContain(FRAMING_RECALL_SENTENCE)
  })

  it('the legacy framing arm does not carry it', async () => {
    // The attribution control depends on this: if `legacy` ALSO carried the
    // sentence, the third arm would differ from the first in nothing that
    // matters and the comparison would be vacuous.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 6_000,
      plugin: true,
      systemPrompt: true,
      efConfig: {
        ...resolvePreset('economy'),
        thresholdRatio: 0.15,
        headroomTokens: 0,
        retainTokens: 700,
        maxTokens: 1_500,
        framingMode: 'legacy',
      },
    })
    const { system } = await assemble(harness)
    expect(system ?? '').not.toContain(FRAMING_RECALL_SENTENCE)
  })

  it('every arm spec declares whether it expects the framing section', () => {
    // A spec that claimed `expectsFramingSection` while mounting `legacy` would
    // silently make the two un-hinted arms identical.
    for (const [arm, spec] of Object.entries(ARM_SPECS)) {
      expect(
        spec.expectsFramingSection,
        `${arm}: expectsFramingSection must agree with framingMode`,
      ).toBe(spec.framingMode === 'system-dedup')
    }
    expect(ARM_SPECS.unhinted.probe).toBe(ARM_SPECS['unhinted-legacy'].probe)
    expect(ARM_SPECS.unhinted.framingMode).not.toBe(ARM_SPECS['unhinted-legacy'].framingMode)
  })
})

describe.skipIf(!LIVE_ENABLED)('RC1.3 live: autonomous retrieval vs the hinted control', () => {
  it('un-hinted baseline, per-fact failure taxonomy, recommended action', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const SMOKE_WINDOW = Number(process.env.EF_LIVE_SMOKE_WINDOW ?? 6_000)
    const REPLICATES = Number(process.env.EF_LIVE_RETRIEVAL_REPLICATES ?? 3)
    const profile = flash()

    // PRODUCTION retention and an identical window/threshold/retain across arms,
    // so the only difference between them is the probe text and the framing mode.
    const shared = {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: Math.floor((SMOKE_WINDOW - 1_500) * 0.16),
      maxTokens: 1_500,
    }

    const arms = ['unhinted', 'hinted', 'unhinted-legacy'] as const

    const runArm = async (arm: Arm, replicate: number): Promise<RetrievalRun> => {
      const spec = ARM_SPECS[arm]
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: SMOKE_WINDOW,
      })
      const recorder = new BillingRecorder(adapter, `${arm}-${replicate}`)
      // The EF economy arm, with the ENRICHED search that RC1.3 ships. Every arm
      // gets it: the hit shape is a product change, not an arm variable, and
      // varying it here would make the probe-text comparison unattributable.
      const harness = await createHarness({ text: 'digest' }, {
        contextWindow: SMOKE_WINDOW,
        plugin: true,
        systemPrompt: true,
        tools: true,
        efConfig: {
          ...resolvePreset('economy'),
          ...shared,
          framingMode: spec.framingMode,
        },
        adapter: { provider: LIVE_PROVIDER, instance: recorder },
      })
      const session = seedNarrative(`rc13-${arm}`)
      const folds = await growAndFold(harness, session, 14, 3_000)
      const factsStillOnSurface = factsOnSurface(session)
      const outcome = await runRecallLoop(harness, session, spec.probe)
      const bill = summarizeFullBill(`${arm}-${replicate}`, recorder.bill, profile)
      return {
        arm,
        replicate,
        outcome,
        folds,
        verdict: verdictFor(outcome),
        factsStillOnSurface,
        cost: bill.cost,
        calls: recorder.bill.length,
        failed: recorder.failedCalls.length,
      }
    }

    const results: Record<Arm, RetrievalRun[]> = {
      unhinted: [], hinted: [], 'unhinted-legacy': [],
    }
    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const arm of arms) {
        const run = await runArm(arm, replicate)
        results[arm].push(run)
        const { outcome, verdict } = run
        console.log(
          `RETRIEVAL rep${replicate} ${arm.padEnd(15)}: folds=${run.folds} rounds=${outcome.rounds} `
          + `search=${outcome.searchCalls} recall=${outcome.recallCalls} other=${outcome.otherCalls} `
          + `truncated=${outcome.truncated} calls=${run.calls} failed=${run.failed} `
          + `cost=${run.cost.toFixed(5)} score=${verdict.score}/${verdict.total} `
          + `primary=${verdict.primary}`,
        )
        // The per-fact labels are the actionable part: "2/3" does not say which
        // link broke, and each label names a different remedy.
        console.log(
          `  facts: ${verdict.facts.map(fact => `${fact.factId}=${fact.failure}`).join(' ')}`,
        )
        // Every tool call, in order, so a surprising score can be explained from
        // the transcript rather than speculated about.
        if (outcome.toolSteps.length > 0) {
          console.log(
            `  tools: ${outcome.toolSteps.map(step =>
              `r${step.round}:${step.name}(${step.outputChars}c${step.isError ? ',ERROR' : ''})`).join(' -> ')}`,
          )
        }
        console.log(`  answer: ${outcome.answer.replace(/\s+/gu, ' ').slice(0, 240)}`)
      }
    }

    // --- Vacuity guard: an arm that never folded measured nothing.
    for (const arm of arms) {
      expect(
        results[arm].every(run => run.folds > 0),
        `${arm} must fold in every replicate`,
      ).toBe(true)
    }

    // --- A TRUNCATED loop is excluded from the tally, never scored as a wrong
    // answer (R4-E). Counting "ran out of rounds" as "lost a fact" manufactures
    // a regression.
    const completed: Record<Arm, RetrievalRun[]> = {
      unhinted: [], hinted: [], 'unhinted-legacy': [],
    }
    for (const arm of arms) {
      for (const run of results[arm]) {
        if (run.outcome.truncated) {
          console.log(
            `EXCLUDED (truncated): ${arm} rep${run.replicate} hit the ${MAX_ROUNDS}-round cap `
            + 'while still calling tools; its answer is incomplete',
          )
          continue
        }
        completed[arm].push(run)
      }
    }

    const mean = (values: readonly number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

    // --- THE PREMISE. Every arm must have actually moved the facts OFF the
    // surface, or the run measures reading rather than retrieval. This is
    // checked per arm rather than assumed, because the legacy framing arm folds
    // fewer times and could in principle leave the facts visible.
    console.log('RETRIEVAL PREMISE (facts still on the surface before the probe):')
    const armsWithVisibleFacts: Arm[] = []
    for (const arm of arms) {
      const visible = results[arm].map(run =>
        [...run.factsStillOnSurface.entries()].filter(([, on]) => on).map(([id]) => id))
      if (visible.some(ids => ids.length > 0)) armsWithVisibleFacts.push(arm)
      console.log(
        `  ${arm.padEnd(15)} visible per run `
        + `[${visible.map(ids => ids.length === 0 ? '-' : ids.join('+')).join(', ')}] `
        + '(a named fact means the surface still carries it)',
      )
    }
    // A run with a visible fact is excluded from the taxonomy, because its
    // labels would describe a different failure than the one being studied.
    for (const arm of armsWithVisibleFacts) {
      console.log(
        `WARNING: ${arm} left facts on the surface; its labels are NOT a retrieval measurement`,
      )
    }

    console.log('RETRIEVAL SUMMARY (completed loops only):')
    for (const arm of arms) {
      const scores = completed[arm].map(run => run.verdict.score)
      const searches = completed[arm].map(run => run.outcome.searchCalls)
      const recalls = completed[arm].map(run => run.outcome.recallCalls)
      console.log(
        `  ${arm.padEnd(15)} n=${scores.length} scores [${scores.join(', ')}] `
        + `mean ${mean(scores).toFixed(2)}/3 | search [${searches.join(', ')}] `
        + `recall [${recalls.join(', ')}]`,
      )
    }

    const unhintedMean = mean(completed.unhinted.map(run => run.verdict.score))
    const hintedMean = mean(completed.hinted.map(run => run.verdict.score))
    const legacyMean = mean(completed['unhinted-legacy'].map(run => run.verdict.score))
    console.log(
      `RETRIEVAL HINT VALUE: un-hinted ${unhintedMean.toFixed(2)}/3 vs hinted `
      + `${hintedMean.toFixed(2)}/3 (delta ${(hintedMean - unhintedMean).toFixed(2)})`,
    )
    // The attribution number RC1.3 §3 actually needs. NOTE the framing section is
    // NOT the only difference between these two arms — legacy also changes the
    // per-checkpoint framing, so it folds a different number of times. This
    // number therefore bounds the framing section's contribution rather than
    // isolating it, and is reported as such.
    console.log(
      `RETRIEVAL FRAMING VALUE: un-hinted ${unhintedMean.toFixed(2)}/3 vs `
      + `un-hinted-legacy ${legacyMean.toFixed(2)}/3 (delta ${(unhintedMean - legacyMean).toFixed(2)}) `
      + '— the framing section names context_recall, so this is what the SHIPPED system prompt buys. '
      + 'The legacy arm also folds a different number of times, so this BOUNDS the contribution '
      + 'rather than isolating it.',
    )

    // --- THE TAXONOMY. This is the deliverable: which link broke, and therefore
    // which single change RC1.3 §2–§3 should make.
    //
    // The SHIPPED configuration is the one the decision applies to, so it is the
    // one classified. The legacy arm is an attribution control and is reported
    // separately: recommending a change to the shipped prompt based on the arm
    // that does not use it would be exactly the misattribution RC1.2.1 corrected.
    const shipped = completed.unhinted.filter(run =>
      [...run.factsStillOnSurface.values()].every(visible => !visible))
    const baselineSummary = summarizeTaxonomy(shipped.map(run => run.verdict))
    console.log('RETRIEVAL TAXONOMY (shipped economy config, un-hinted probe):')
    console.log(`  runs: ${baselineSummary.runs} of ${completed.unhinted.length} completed`)
    for (const [label, count] of Object.entries(baselineSummary.byPrimary)) {
      if (count > 0) console.log(`  primary ${label}: ${count} run(s)`)
    }
    for (const [label, count] of Object.entries(baselineSummary.byFact)) {
      if (count > 0) console.log(`  fact-level ${label}: ${count}`)
    }
    const action = recommendedAction(baselineSummary)
    console.log(`RETRIEVAL RECOMMENDED ACTION: ${action.action}`)
    console.log(`  because: ${action.rationale}`)

    const legacySummary = summarizeTaxonomy(
      completed['unhinted-legacy']
        .filter(run => [...run.factsStillOnSurface.values()].every(visible => !visible))
        .map(run => run.verdict),
    )
    console.log(
      `RETRIEVAL ATTRIBUTION CONTROL (unhinted-legacy, no framing section): `
      + `primary ${JSON.stringify(legacySummary.byPrimary)}, `
      + `fact-level ${JSON.stringify(legacySummary.byFact)}`,
    )

    // The mechanism is EF-only and must be reported as such; there is no Basic
    // arm here at all, so the RC1.2.1 misattribution cannot recur.
    console.log('RETRIEVAL MECHANISM: EF arms only; no Basic arm exists in this suite.')

    // The assertions record the OUTCOME rather than a pass/fail on a policy: a
    // baseline that scores low is a legitimate finding whose value is the
    // taxonomy, not a failed test.
    for (const arm of arms) expect(completed[arm].length).toBe(REPLICATES)
    expect(
      results.unhinted.every(run => run.outcome.providerCalls > 0),
      'the un-hinted arm must have made model calls',
    ).toBe(true)
  }, 2_400_000)
})
