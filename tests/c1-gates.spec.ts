/**
 * EF-C1 gate tests.
 *
 * Two kinds of assertion:
 *
 *  1. SYNTHETIC: a failed test summary must fail the isolation gate, and the
 *     exit codes must distinguish pass / fail / non-pass.
 *  2. REAL: the committed C1 artifacts must satisfy every gate, and the three
 *     eligibility booleans must stay distinct.
 *
 * @module tests/c1-gates
 */

import { describe, expect, it } from 'vitest'
import { evaluateGates, exitCodeFor } from '../eval/c1/gates.mjs'

const IDS = [
  'C1-G0', 'C1-G1', 'C1-G2', 'C1-G3',
  'C1-G4', 'C1-G5', 'C1-G6', 'C1-G7',
]

describe('EF-C1 gates: the real artifacts', () => {
  // The gate run (`npm run eval:c1-gates`) reads eval/c1/out/c1-tests.json.
  // This unit test supplies a passing override so it does not depend on the
  // order in which the pipeline wrote that file; the synthetic test below is
  // what proves a failing summary fails the gate.
  const passing = { success: true, numFailedTests: 0, numPassedTests: 1, numTotalTests: 1 }

  it('every gate is present and passed', () => {
    const report = evaluateGates({ testsOverride: passing })
    expect(report.gates.map(gate => gate.id)).toEqual(IDS)
    expect(report.eligibility.evaluated).toBe(8)
    expect(report.eligibility.failed).toBe(0)
    expect(report.eligibility.nonPass).toBe(0)
    expect(report.eligibility.stageComplete).toBe(true)
    expect(exitCodeFor(report.eligibility)).toBe(0)
  })

  it('keeps stage completion, core release and semantic active SEPARATE', () => {
    const report = evaluateGates({ testsOverride: passing })
    expect(report.eligibility.stageComplete).toBe(true)
    // Offline completion is not product evidence. The reason must name the
    // actual gap (no product-quality experiment), not a defect that was fixed:
    // a stale blocker text is how a resolved issue keeps suppressing a release.
    expect(report.decisions.coreReleaseEligible).toBe(false)
    expect(report.decisions.coreReleaseReason).toContain('offline-only')
    expect(report.decisions.coreReleaseReason).not.toContain('B04')
    // Deployment hold is not lifted by an offline result.
    expect(report.decisions.semanticActiveEligible).toBe(false)
    expect(report.product.deploymentEligible).toBe(false)
  })
})

describe('EF-C1 gates: synthetic failures', () => {
  it('a failed test summary fails the isolation gate, and exit code 1', () => {
    const report = evaluateGates({
      testsOverride: { success: false, numFailedTests: 1, numPassedTests: 0, numTotalTests: 1 },
    })
    const g1 = report.gates.find(gate => gate.id === 'C1-G1')
    expect(g1?.status).toBe('failed')
    expect(report.eligibility.failed).toBeGreaterThan(0)
    expect(report.eligibility.stageComplete).toBe(false)
    expect(exitCodeFor(report.eligibility)).toBe(1)
  })

  it('a non-pass status is exit 2, not a crash and not a pass', () => {
    expect(exitCodeFor({ failed: 0, nonPass: 1 })).toBe(2)
    expect(exitCodeFor({ failed: 1, nonPass: 1 })).toBe(1)
    expect(exitCodeFor({ failed: 0, nonPass: 0 })).toBe(0)
  })
})
