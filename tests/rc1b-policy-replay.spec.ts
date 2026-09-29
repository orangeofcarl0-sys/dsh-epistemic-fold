/**
 * RC1-B: replay first, so parameters are never searched with the API.
 *
 * The load-bearing claim is `SimPolicy == ProductionPolicy`. If the simulator
 * ever grows its own copy of admission or break-even logic, every number it
 * produces describes a policy the product does not have — the same failure R3
 * fixed as `BenchPath == ProductionPath`. So the first test pins the delegation
 * structurally, by reading the module's own imports.
 *
 * The second claim is the one RC1 §15/§16 actually asks for: a BROAD PLATEAU,
 * not an argmin. A scan that returns a single best point has produced a fitted
 * parameter, and shipping it would be exactly the overfitting the directive
 * forbids.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile } from '../src/economics-profile.ts'
import { resolveEfConfig } from '../src/policy.ts'
import { checkpointSizeOf, medianGrowth, syntheticTrace, traceFromBaseline } from '../eval/policy-replay/trace.ts'
import { replayGate, replayPaired, simulate } from '../eval/policy-replay/simulator.ts'
import type { ReplayPolicy } from '../eval/policy-replay/simulator.ts'
import { findPlateau, scan, scanToMarkdown } from '../eval/policy-replay/report.ts'
import { buildCorpus, CORPUS_RESERVED, CORPUS_WINDOW, SYNTHETIC_RESERVED, SYNTHETIC_WINDOW } from '../eval/policy-replay/corpus.ts'
import { runPairedBaseline } from '../bench/paired-baseline.ts'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Session } from '@deepseek-ai/dsh-session'

const PROFILE = resolveProfile(BUILTIN_ECONOMICS_PROFILES, 'deepseek', 'deepseek-v4.1-flash')

/**
 * Build a candidate policy for the scan.
 *
 * Every `ReplayPolicy` field is honored, including the window: a helper that
 * silently dropped an override would make a test's stated window a lie, which
 * is exactly the class of error this stage is trying to remove.
 */
function candidatePolicy(overrides: Partial<ReplayPolicy> & {
  readonly config?: Record<string, unknown>
} = {}): ReplayPolicy {
  const { config, ...rest } = overrides
  return {
    config: {
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      semanticMode: 'none',
      // Set explicitly, NOT left to the engine default: the shipped 65536
      // reserve exceeds this corpus's whole 8000-token window, so an unset
      // headroom makes `resolveEfCompactSpec` throw rather than replay. That
      // throw is RC1-A's finding reproduced by accident, and a scan helper must
      // not depend on it.
      headroomTokens: 0,
      ...config,
    },
    contextWindow: CORPUS_WINDOW,
    reservedCompletionTokens: CORPUS_RESERVED,
    // A scalar realization is expanded to every class; the RC1.1 suites use
    // the class-aware scenarios, and this one is retained for the RC1-B replay
    // whose subject is the policy arithmetic rather than the cache model.
    realization: 0.9,
    fallbackCheckpointTokens: 200,
    basicCheckpointTokens: 400,
    outputTokensPerRequest: 200,
    idleMaintenance: true,
    ...rest,
  }
}

describe('RC1-B: the simulator reuses production policy, it does not restate it', () => {
  it('imports the production policy functions rather than reimplementing them', () => {
    const source = readFileSync(
      join(process.cwd(), 'eval', 'policy-replay', 'simulator.ts'),
      'utf8',
    )
    const importBlock = source
      .split(String.fromCharCode(10))
      .filter(line => line.startsWith('import ') || line.trimStart().startsWith('} from '))
      .join(String.fromCharCode(10))
    // The three decisions the simulator must NOT own.
    expect(importBlock).toContain('leafMarginalReclaim')
    expect(importBlock).toContain('compileContextPolicy')
    expect(importBlock).toContain('resolveEfCompactSpec')
    // And it must not carry its own break-even arithmetic: a local
    // `rootBreakEvenRequests` would be a second policy, not a reuse.
    expect(source).not.toMatch(/function\s+rootBreakEvenRequests/u)
    expect(source).not.toMatch(/function\s+leafMarginalReclaim/u)
  })

  it('reproduces the production threshold from the production config', () => {
    const trace = syntheticTrace('t', { steps: 5, growthTokens: 1_000, contextWindow: CORPUS_WINDOW })
    const result = simulate(trace, candidatePolicy({ config: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0 } }), 'ef', PROFILE)
    const resolved = resolveEfConfig({
      leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0,
    })
    expect(resolved.thresholdRatio).toBe(0.15)
    // 8000 * 0.15 = 1200, and the first step alone (1000) is under it.
    expect(result.steps[0]!.folded).toBe(false)
    expect(result.steps[1]!.folded).toBe(true)
  })

  it('treats a trace that never cycles as VACUOUS, not as a pass', () => {
    // The failure this guards is the flattering one: two identical runs cost
    // the same, so a corpus that never folds reports a worst cost ratio of 1
    // for every candidate and a scan "passes" everything without measuring
    // anything.
    const flat = syntheticTrace('flat', { steps: 10, growthTokens: 10, contextWindow: CORPUS_WINDOW })
    const paired = replayPaired(flat, candidatePolicy({ config: { thresholdRatio: 0.8 } }), PROFILE)
    const gate = replayGate(paired)
    expect(gate.vacuous).toBe(true)
    expect(gate.passed).toBe(false)
    expect(gate.failures.join(' ')).toContain('vacuous')
  })

  it('keeps the frozen prefix MONOTONIC for EF and re-foldable for Basic', () => {
    // The structural difference between the arms. EF may never re-fold a frozen
    // checkpoint, so between rebases its prefix grows by one checkpoint per
    // fold; Basic's fold replaces its own summary, so it carries no frozen
    // prefix at all.
    //
    // Maintenance is OFF here deliberately: a rebase is the ONE thing that
    // legitimately collapses EF's frozen prefix, and leaving it on would make
    // the monotonicity claim untestable rather than false.
    const trace = syntheticTrace('mono', { steps: 24, growthTokens: 1_200, contextWindow: CORPUS_WINDOW })
    const policy = candidatePolicy({
      config: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0 },
      idleMaintenance: false,
    })
    const ef = simulate(trace, policy, 'ef', PROFILE)
    const basic = simulate(trace, policy, 'basic', PROFILE)
    expect(ef.leafFolds).toBeGreaterThan(2)
    expect(basic.leafFolds).toBeGreaterThan(2)
    expect(ef.rootRebases).toBe(0)
    // EF's frozen load never decreases across steps...
    for (let index = 1; index < ef.steps.length; index += 1) {
      expect(ef.steps[index]!.frozenTokens).toBeGreaterThanOrEqual(ef.steps[index - 1]!.frozenTokens)
    }
    // ...and it ends strictly positive, while Basic's is always zero.
    expect(ef.steps[ef.steps.length - 1]!.frozenTokens).toBeGreaterThan(0)
    expect(basic.steps.every(step => step.frozenTokens === 0)).toBe(true)
    // The prefix is exactly one checkpoint per fold: no re-folding, no decay.
    expect(ef.steps[ef.steps.length - 1]!.frozenTokens).toBe(ef.leafFolds * 200)
  })

  it('a rebase is the ONE thing that collapses the frozen prefix, and it is reported', () => {
    // The complement of the test above: with maintenance ON, the prefix still
    // grows monotonically BETWEEN rebases, and each rebase is counted rather
    // than silently absorbed into the trajectory.
    //
    // Growth is set below the threshold (0.15 x 32768 = 4915) so the trace
    // cycles at a realistic cadence; a growth larger than the threshold folds
    // every single step, which is the pathological loop rather than a
    // trajectory a rebase policy is meant to reason about. The window is passed
    // explicitly AND carried by the trace, so `replayPaired` cannot silently
    // substitute the corpus's smaller observation window.
    const trace = syntheticTrace('rebase', {
      steps: 40, growthTokens: 2_400, contextWindow: SYNTHETIC_WINDOW,
      reservedCompletionTokens: SYNTHETIC_RESERVED, declaredCheckpointTokens: 600,
    })
    const policy = candidatePolicy({
      config: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0 },
      contextWindow: SYNTHETIC_WINDOW,
      reservedCompletionTokens: SYNTHETIC_RESERVED,
      idleMaintenance: true,
    })
    const ef = simulate(trace, { ...policy, contextWindow: trace.contextWindow, reservedCompletionTokens: trace.reservedCompletionTokens }, 'ef', PROFILE)
    expect(ef.rootRebases).toBeGreaterThan(0)
    // The cadence is not the fold-every-step loop.
    expect(ef.longestFoldRun).toBeLessThan(5)

    // A rebase leaves exactly ONE checkpoint frozen. The step that rebases may
    // ALSO fold afterwards — maintenance runs before the pressure fold, which is
    // the production order — so the observable invariant is that the prefix is
    // bounded by one checkpoint plus at most the fold that followed, never by
    // the whole accumulated history.
    const afterRebase = ef.steps.filter(step => step.rebased)
    expect(afterRebase.length).toBe(ef.rootRebases)
    for (const step of afterRebase) {
      expect(step.frozenTokens).toBeGreaterThanOrEqual(600)
      expect(step.frozenTokens).toBeLessThanOrEqual(1_200)
    }
    // And the rebase is what keeps it there: without maintenance the prefix
    // grows without bound across the same trajectory.
    const noMaintenance = simulate(
      trace,
      { ...policy, contextWindow: trace.contextWindow, reservedCompletionTokens: trace.reservedCompletionTokens, idleMaintenance: false },
      'ef',
      PROFILE,
    )
    expect(noMaintenance.rootRebases).toBe(0)
    expect(noMaintenance.steps[noMaintenance.steps.length - 1]!.frozenTokens)
      .toBeGreaterThan(afterRebase[afterRebase.length - 1]!.frozenTokens)
  })
})

describe('RC1-B: a real trace is extracted from a real run', () => {
  it('measures checkpoint size rather than assuming it', async () => {
    const workload = allWorkloads()[0]!
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: CORPUS_WINDOW, workloadModel: WORKLOAD_MODEL,
      plugin: true, systemPrompt: true,
      efConfig: {
        thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: CORPUS_RESERVED,
        leafAdmission: 'economic', rootPolicy: 'economics',
        semanticMode: 'none', framingMode: 'system-dedup',
      },
    })
    const result = await runPairedBaseline({
      arm: 'trace', harness, createSession: workload.createSession, steps: 30,
      grow: (session: Session, step: number) => workload.grow(session, step),
      signal: SIGNAL,
    })
    const trace = traceFromBaseline(workload.id, result, {
      contextWindow: CORPUS_WINDOW,
      reservedCompletionTokens: CORPUS_RESERVED,
      headroomTokens: 0,
      thresholdRatio: 0.15,
    })
    // The vacuity guard: a trace with no fold carries no checkpoint evidence,
    // and a replay built on one would be arithmetic about nothing.
    expect(result.leafFoldCount).toBeGreaterThan(2)
    expect(trace.checkpointSizes.length).toBeGreaterThan(0)
    const size = checkpointSizeOf(trace, 200)
    expect(size.evidenced).toBe(true)
    expect(size.origin).toBe('measured')
    expect(size.tokens).toBeGreaterThan(0)
    // Growth is recorded per step, and it is positive.
    expect(medianGrowth(trace)).toBeGreaterThan(0)
    // An unevidenced trace says so rather than silently borrowing a number, and
    // reports WHICH unevidenced source it used — a declared premise and a
    // caller fallback support different strengths of claim.
    const empty = syntheticTrace('synthetic:never-folds', { steps: 3, growthTokens: 10, contextWindow: CORPUS_WINDOW })
    expect(checkpointSizeOf(empty, 200)).toEqual({ tokens: 200, evidenced: false, origin: 'fallback' })
    const declared = syntheticTrace('synthetic:declared', {
      steps: 3, growthTokens: 10, contextWindow: CORPUS_WINDOW, declaredCheckpointTokens: 600,
    })
    expect(checkpointSizeOf(declared, 200)).toEqual({ tokens: 600, evidenced: false, origin: 'declared' })
  }, 300_000)
})

describe('RC1-B: the scan finds a plateau, not a fitted minimum', () => {
  it('scans alpha / headroom / retain and reports the qualifying band', async () => {
    const corpus = await buildCorpus({ observedSteps: 30, syntheticSteps: 60 })
    expect(corpus.length).toBe(6)

    const candidates = [
      ...[0.5, 0.6, 0.7, 0.75, 0.8, 0.85].map(alpha => ({
        label: `alpha=${alpha}`,
        config: { thresholdRatio: alpha },
        policy: candidatePolicy({ config: { thresholdRatio: alpha, headroomTokens: 0, retainTokens: 0 } }),
      })),
      ...[0, 512, 1_024].map(headroom => ({
        label: `headroom=${headroom}`,
        config: { headroomTokens: headroom },
        policy: candidatePolicy({ config: { thresholdRatio: 0.8, headroomTokens: headroom, retainTokens: 0 } }),
      })),
      ...[0, 200, 400].map(retain => ({
        label: `retain=${retain}`,
        config: { retainTokens: retain },
        policy: candidatePolicy({ config: { thresholdRatio: 0.8, headroomTokens: 0, retainTokens: retain } }),
      })),
    ]
    const points = scan(corpus, candidates, PROFILE)
    console.log(scanToMarkdown(points))

    // Every candidate must produce a finite, positive cost ratio — a NaN or a
    // zero here would mean the replay silently priced nothing.
    for (const point of points) {
      expect(Number.isFinite(point.worstCostRatio)).toBe(true)
      expect(point.worstCostRatio).toBeGreaterThan(0)
    }

    const plateau = findPlateau(points, {
      tolerance: 1,
      minWidth: 3,
      prefer: ['alpha=0.8', 'headroom=0', 'retain=0'],
    })
    console.log(`PLATEAU: found=${plateau.found} labels=[${plateau.labels.join(', ')}]`)
    console.log(`PLATEAU: ${plateau.reason}`)
    if (plateau.recommended !== undefined) {
      console.log(`PLATEAU RECOMMENDED: ${plateau.recommended.label} worst=${plateau.recommended.worstCostRatio.toFixed(3)}`)
    }

    // The recommendation, whenever there is one, must be a SIMPLE value that a
    // mature implementation would already have chosen — never a fitted decimal.
    if (plateau.found && plateau.recommended !== undefined) {
      expect(['alpha=0.8', 'alpha=0.75', 'headroom=0', 'retain=0'])
        .toContain(plateau.recommended.label)
    }
  }, 600_000)

  it('refuses to call a single qualifying point a plateau', () => {
    // The overfitting guard, tested directly: one point inside tolerance is a
    // fitted parameter, and reporting it as a robust region is the error RC1
    // §16 names.
    const narrow = findPlateau([
      { label: 'a', config: {}, worstCostRatio: 0.99, meanCostRatio: 0.9, overflowEvents: 0, worstFoldRun: 1, failedTraces: [], vacuousTraces: [], pairs: [] },
      { label: 'b', config: {}, worstCostRatio: 1.4, meanCostRatio: 1.2, overflowEvents: 0, worstFoldRun: 1, failedTraces: [], vacuousTraces: [], pairs: [] },
      { label: 'c', config: {}, worstCostRatio: 1.8, meanCostRatio: 1.5, overflowEvents: 0, worstFoldRun: 1, failedTraces: [], vacuousTraces: [], pairs: [] },
    ], { minWidth: 3 })
    expect(narrow.found).toBe(false)
    expect(narrow.reason).toContain('fitted parameter')
  })

  it('refuses to report a plateau when every candidate was vacuous', () => {
    // The flattering failure: a corpus that never cycles gives every candidate
    // a worst ratio of 0 and no failed traces, so a naive plateau check would
    // announce a perfect band that measured nothing at all.
    const allVacuous = findPlateau([
      { label: 'a', config: {}, worstCostRatio: 0, meanCostRatio: Number.NaN, overflowEvents: 0, worstFoldRun: 0, failedTraces: [], vacuousTraces: ['t1', 't2'], pairs: [] },
      { label: 'b', config: {}, worstCostRatio: 0, meanCostRatio: Number.NaN, overflowEvents: 0, worstFoldRun: 0, failedTraces: [], vacuousTraces: ['t1', 't2'], pairs: [] },
      { label: 'c', config: {}, worstCostRatio: 0, meanCostRatio: Number.NaN, overflowEvents: 0, worstFoldRun: 0, failedTraces: [], vacuousTraces: ['t1', 't2'], pairs: [] },
    ], { minWidth: 3 })
    expect(allVacuous.found).toBe(false)
    expect(allVacuous.reason).toContain('no trace in the corpus cycled')
  })

  it('gates on the worst trace, not the mean', () => {
    // A candidate that is cheap on average and above 1 somewhere is not
    // cheaper; it is cheaper for some workloads and dearer for others.
    const paired = replayPaired(
      syntheticTrace('wide', { steps: 40, growthTokens: 4_000, contextWindow: CORPUS_WINDOW }),
      candidatePolicy({ config: { thresholdRatio: 0.8, headroomTokens: 0, retainTokens: 0 } }),
      PROFILE,
    )
    const gate = replayGate(paired, { costTolerance: 1 })
    expect(gate.passed).toBe(paired.costRatio <= 1 && paired.candidate.overflowEvents === 0)
  })
})
