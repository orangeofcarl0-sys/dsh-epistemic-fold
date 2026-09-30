/**
 * RC7-E: the engagement classifier and the split metric set (keyless).
 *
 * The classifier is pure, so it is verified here rather than only through a live
 * run. That matters because the failure it prevents is a REPORTING failure: a
 * misclassification does not crash anything, it silently produces a plausible
 * table that says the wrong thing.
 *
 * The fixtures below are the actual shapes the first parallel runs produced —
 * including the early-stop timeline that started this work:
 *
 *   rounds=4  calls=4  timeline: list_files -> context_search
 *   LOST constraint-retained, revision-honoured, no-resurrection, interface-honoured
 *
 * @module tests/rc7e-engagement
 */

import { describe, expect, it } from 'vitest'
import {
  EXECUTION_CONTRACTS,
  armReportsToText,
  classifyEngagement,
  reportArm,
  sampleCaveat,
} from '../eval/real-task/engagement.ts'
import { assertPurposeAllowed } from '../eval/real-task/parallel.ts'
import type { TaskRun } from '../eval/real-task/metrics.ts'

/** One quality check in the shape the driver records. */
function check(id: string, passed: boolean) {
  return { id, passed, detail: id }
}

/**
 * A run for `coding-paginate`.
 *
 * Defaults describe a FULLY ENGAGED, fully correct run; each test overrides the
 * one dimension it is about, so a failure names the dimension that broke.
 */
function codingRun(overrides: Partial<TaskRun> & {
  readonly checks?: readonly { id: string; passed: boolean; detail: string }[]
  readonly probes?: readonly { id: string; held: boolean; question: string }[]
} = {}): TaskRun {
  const checks = overrides.checks ?? [
    check('module-exists', true),
    check('named-export', true),
    check('test-exists', true),
    check('no-mutation', true),
  ]
  const probes = overrides.probes ?? [
    { id: 'constraint-retained', held: true, question: 'q' },
    { id: 'revision-honoured', held: true, question: 'q' },
    { id: 'no-resurrection', held: true, question: 'q' },
    { id: 'interface-honoured', held: true, question: 'q' },
  ]
  const passed = checks.filter(c => c.passed).length
  const held = probes.filter(p => p.held).length
  return {
    arm: 'economy',
    taskId: 'coding-paginate',
    outcome: 'answered',
    rounds: 12,
    cost: {
      total: 0.004, calls: 12, failedCalls: 0,
      uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
    },
    quality: {
      passed, total: checks.length, score: checks.length === 0 ? 0 : passed / checks.length,
      checks,
    },
    steadiness: {
      probes,
      satisfied: held,
      total: probes.length,
      // `score` is part of the real type. Omitting it here produced a NaN mean
      // that the `as TaskRun` cast hid — the fixture must carry every field the
      // report reads, or the test passes against a shape production never has.
      score: probes.length === 0 ? 0 : held / probes.length,
    },
    toolCalls: { write_file: 3, run_node: 1 },
    timeline: ['list_files', 'write_file', 'write_file', 'run_node'],
    answer: 'done',
    ...overrides,
  } as TaskRun
}

/**
 * Recompute the derived counts after an override replaces `checks` or `probes`.
 *
 * `overrides` is spread last, so a caller that supplies only `probes` would
 * otherwise leave `satisfied`/`total`/`score` describing the DEFAULT array — a
 * fixture that silently disagrees with itself.
 */
function withDerived(run: TaskRun): TaskRun {
  const held = run.steadiness.probes.filter(p => p.held).length
  const passed = run.quality.checks.filter(c => c.passed).length
  return {
    ...run,
    quality: {
      ...run.quality,
      passed,
      total: run.quality.checks.length,
      score: run.quality.checks.length === 0 ? 0 : passed / run.quality.checks.length,
    },
    steadiness: {
      ...run.steadiness,
      satisfied: held,
      total: run.steadiness.probes.length,
      score: run.steadiness.probes.length === 0 ? 0 : held / run.steadiness.probes.length,
    },
  }
}

describe('RC7-E: engagement is decided by the task contract, not by tool counts', () => {
  it('a run that wrote its artifacts, exposed the interface and executed is COMPLETED', () => {
    const evidence = classifyEngagement(withDerived(codingRun()))
    expect(evidence.verdict).toBe('completed')
    expect(evidence.missing).toEqual([])
    expect(evidence.artifactsMet).toBe(2)
    expect(evidence.interfaceMet).toBe(1)
    expect(evidence.executed).toBe(true)
  })

  it('THE EARLY-STOP CASE: answered with no artifacts is answered-incomplete', () => {
    // The real timeline from the first parallel runs: two reads, no writes, and
    // an answer. The old metric scored this 0.00 quality, which pooled with four
    // 1.00s to produce a mean of 0.80 that described no actual run.
    const run = withDerived(codingRun({
      rounds: 4,
      timeline: ['list_files', 'context_search'],
      checks: [
        check('module-exists', false),
        check('named-export', false),
        check('test-exists', false),
        check('no-mutation', false),
      ],
      probes: [
        { id: 'constraint-retained', held: false, question: 'q' },
        { id: 'revision-honoured', held: false, question: 'q' },
        { id: 'no-resurrection', held: false, question: 'q' },
        { id: 'interface-honoured', held: false, question: 'q' },
      ],
    }))
    const evidence = classifyEngagement(run)
    expect(evidence.verdict).toBe('answered-incomplete')
    // ...and the evidence names WHY, rather than only that it failed.
    expect(evidence.missing).toContain('module-exists')
    expect(evidence.missing).toContain('test-exists')
    expect(evidence.missing).toContain('named-export')
    expect(evidence.missing).toContain('ran:run_node')
  })

  it('writing the files WITHOUT exposing the interface is still incomplete', () => {
    // The task named a specific interface. A file that exists but does not
    // export `paginate` has not done what was asked.
    const run = withDerived(codingRun({
      checks: [
        check('module-exists', true),
        check('named-export', false),
        check('test-exists', true),
        check('no-mutation', true),
      ],
    }))
    expect(classifyEngagement(run).verdict).toBe('answered-incomplete')
    expect(classifyEngagement(run).missing).toEqual(['named-export'])
  })

  it('writing and exporting but never RUNNING is still incomplete', () => {
    // Every task in this suite says "run it with run_node". Producing files
    // without executing them skips a step the task explicitly required.
    const run = withDerived(codingRun({ timeline: ['list_files', 'write_file', 'write_file'] }))
    const evidence = classifyEngagement(run)
    expect(evidence.verdict).toBe('answered-incomplete')
    expect(evidence.executed).toBe(false)
    expect(evidence.missing).toContain('ran:run_node')
  })

  it('a FEWER-TOOL run that satisfies the contract is completed — no count gate', () => {
    // The directive is explicit that "tool calls >= N" must not be the gate: a
    // better model may finish in fewer calls. This run uses three calls where the
    // default fixture uses four, and still completes.
    const run = withDerived(codingRun({ timeline: ['write_file', 'write_file', 'run_node'], rounds: 5 }))
    expect(classifyEngagement(run).verdict).toBe('completed')
  })

  it('truncation outranks completion: the round cap is why it stopped', () => {
    // A truncated run may have written its files before the cap. It is still
    // truncated, because the run did not finish on its own terms.
    const run = withDerived(codingRun({ outcome: 'truncated' }))
    expect(classifyEngagement(run).verdict).toBe('truncated')
  })

  it('a transport failure is its own outcome, never a completion', () => {
    const run = withDerived(codingRun({ outcome: 'transport-failed' }))
    expect(classifyEngagement(run).verdict).toBe('transport-failed')
  })

  it('an unknown task id FAILS LOUD rather than defaulting to engaged', () => {
    // A default would classify an unmeasured task as engaged, which is exactly
    // the class of silent overclaim this project keeps having to fix.
    expect(() => classifyEngagement(codingRun({ taskId: 'no-such-task' })))
      .toThrow(/no execution contract/u)
  })

  it('every task in the suite has a contract, and every named check exists', () => {
    // The contracts name quality-check ids. A typo would silently make a
    // required milestone unfindable, which reads as "the model never did it".
    for (const [taskId, contract] of Object.entries(EXECUTION_CONTRACTS)) {
      expect(contract.requiredArtifacts.length, `${taskId} needs artifacts`).toBeGreaterThan(0)
      expect(contract.executionTool, `${taskId} must state its execution tool`).toBe('run_node')
    }
  })
})

describe('RC7-E: the split report', () => {
  it('reports the two layers separately, and never pools them', () => {
    // THE CASE THAT STARTED THIS: four complete successes and one early-stop.
    const runs: TaskRun[] = [
      codingRun(),
      codingRun(),
      codingRun(),
      codingRun(),
      codingRun({
        rounds: 4,
        timeline: ['list_files', 'context_search'],
        checks: [check('module-exists', false), check('named-export', false),
          check('test-exists', false), check('no-mutation', false)],
        probes: [{ id: 'constraint-retained', held: false, question: 'q' },
          { id: 'revision-honoured', held: false, question: 'q' },
          { id: 'no-resurrection', held: false, question: 'q' },
          { id: 'interface-honoured', held: false, question: 'q' }],
      }),
    ]
    const report = reportArm('economy', 'economy', runs)

    // Layer 1: the honest counts.
    expect(report.n).toBe(5)
    expect(report.completed).toBe(4)
    expect(report.answeredIncomplete).toBe(1)
    expect(report.completionRate).toBeCloseTo(0.8, 5)

    // Layer 2: conditional on engagement — and therefore 1.00, not 0.80.
    expect(report.qualityGivenCompleted).toBe(1)
    expect(report.steadyGivenCompleted).toBe(1)

    // The unconditional bottom line.
    expect(report.e2eSuccess).toBe(4)
    expect(report.e2eSuccessRate).toBeCloseTo(0.8, 5)

    // Cost per SUCCESSFUL task charges the failure to the arm that produced it:
    // five runs' cost divided by four successes, not by five.
    expect(report.totalCost).toBeCloseTo(0.02, 6)
    expect(report.costPerSuccess).toBeCloseTo(0.005, 6)
  })

  it('quality|completed EXCLUDES a run that engaged but lost a fact', () => {
    // The other direction: a run that did the work and still dropped a
    // constraint is COMPLETED but scores below 1.00 on the conditional layer.
    // That is the layer where EF's value would show up.
    const runs = [
      codingRun(),
      codingRun({ probes: [
        { id: 'constraint-retained', held: true, question: 'q' },
        { id: 'revision-honoured', held: false, question: 'q' },
        { id: 'no-resurrection', held: false, question: 'q' },
        { id: 'interface-honoured', held: true, question: 'q' },
      ] }),
    ]
    const report = reportArm('balanced', 'balanced', runs)
    expect(report.completed).toBe(2)
    expect(report.qualityGivenCompleted).toBe(1)
    expect(report.steadyGivenCompleted).toBeCloseTo(0.75, 5)
    // ...and it is NOT an e2e success, because e2e is the conjunction per run.
    expect(report.e2eSuccess).toBe(1)
  })

  it('cost/success is undefined when nothing succeeded, not Infinity or a mean', () => {
    const failed = codingRun({
      checks: [check('module-exists', false), check('named-export', false),
        check('test-exists', false), check('no-mutation', false)],
    })
    const report = reportArm('basic', 'legacy', [failed, failed])
    expect(report.e2eSuccess).toBe(0)
    expect(report.costPerSuccess).toBeUndefined()
    expect(report.qualityGivenCompleted).toBeUndefined()
    // The total is still reported: the arm did spend that money.
    expect(report.totalCost).toBeCloseTo(0.008, 6)
  })

  it('renders counts as k/n, never as a percentage', () => {
    // "1/5" says what was observed. "20%" claims a property of the population,
    // which five runs cannot support.
    const text = armReportsToText([reportArm('economy', 'economy', [codingRun()])])
    expect(text).toContain('1/1')
    expect(text).not.toMatch(/\d+%/u)
  })

  it('the caveat refuses to convert counts into rates, and refuses to blame a mode', () => {
    const runs = [withDerived(codingRun()), withDerived(codingRun({ rounds: 4, timeline: ['list_files'],
      checks: [check('module-exists', false), check('named-export', false),
        check('test-exists', false), check('no-mutation', false)] }))]
    const caveat = sampleCaveat([reportArm('economy', 'economy', runs)], 1)
    expect(caveat).toMatch(/not rate estimates/u)
    // With an early-stop present, the caveat must refuse to attribute it.
    expect(caveat).toMatch(/cannot separate a mode/u)
    // ...and the "no claim of stability" line belongs to the OTHER case, so it
    // must NOT appear here: an early-stop was seen.
    expect(caveat).not.toMatch(/not a claim of stability/u)
  })

  it('a batch with NO early-stop says so, and still refuses to claim stability', () => {
    // The other half of the same honesty rule. Five clean runs is the tempting
    // moment to declare an arm stable; the caveat exists to refuse that.
    const caveat = sampleCaveat(
      [reportArm('quality', 'quality', Array.from({ length: 5 }, () => withDerived(codingRun())))],
      1,
    )
    expect(caveat).toMatch(/No early-stop was OBSERVED/u)
    expect(caveat).toMatch(/not a claim of stability/u)
  })
})

describe('RC7-E: the cost gate is protected from concurrent runs', () => {
  it('refuses a cost claim from a run with more than one cell in flight', () => {
    // A contaminated cost number looks exactly like a clean one. The project's
    // cost gate is OPEN partly because of a cross-run cache contamination
    // incident, so this is a throw rather than a warning.
    expect(() => assertPurposeAllowed('cost', 6)).toThrow(/may not use concurrency/u)
    expect(() => assertPurposeAllowed('cost', 2)).toThrow(/prefix cache/u)
  })

  it('allows a cost claim only from a serial run', () => {
    expect(() => assertPurposeAllowed('cost', 1)).not.toThrow()
  })

  it('allows a quality run at any concurrency, which is the default', () => {
    // Quality and steadiness are safe in parallel: each cell owns its workspace,
    // session and engine. Only COST is contaminated by sharing a provider cache.
    expect(() => assertPurposeAllowed('quality', 50)).not.toThrow()
  })
})
