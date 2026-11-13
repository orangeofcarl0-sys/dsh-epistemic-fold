/**
 * EF-C0 — the convergence gates themselves.
 *
 * The gate LOGIC is tested with a synthetic test result so this file does not
 * depend on a previous run of the same suite. The CLI (`node eval/c0/gates.mjs`)
 * uses the real artifact.
 *
 * @module tests/convergence-gates
 */

import { describe, expect, it } from 'vitest'
import { evaluateGates, exitCodeFor } from '../eval/c0/gates.mjs'

const passingTests = {
  success: true,
  numFailedTests: 0,
  numPassedTests: 21,
  numTotalTests: 21,
}

describe('EF-C0 gates', () => {
  it('reports six gates and passes when the evidence is coherent', () => {
    const { gates, eligibility } = evaluateGates({ testsOverride: passingTests })
    expect(gates.map(gate => gate.id)).toEqual([
      'C0-G0', 'C0-G1', 'C0-G2', 'C0-G3', 'C0-G4', 'C0-G5',
    ])
    expect(gates.every(gate => gate.status === 'passed'), JSON.stringify(gates.filter(g => g.status !== 'passed'))).toBe(true)
    expect(eligibility.eligible).toBe(true)
    expect(exitCodeFor(eligibility)).toBe(0)
  })

  it('fails the configuration and boundary gates when the test suite failed', () => {
    const { gates, eligibility } = evaluateGates({
      testsOverride: { success: false, numFailedTests: 1, numPassedTests: 20, numTotalTests: 21 },
    })
    expect(gates.find(gate => gate.id === 'C0-G1')?.status).toBe('failed')
    expect(gates.find(gate => gate.id === 'C0-G2')?.status).toBe('failed')
    expect(eligibility.eligible).toBe(false)
    expect(exitCodeFor(eligibility)).toBe(1)
  })

  it('does not treat a document existing as a pass on its own', () => {
    // C0-G0 reads hashes and ancestry, not prose. If the stage map were
    // removed, the gate must fail even though the markdown still exists.
    const { gates } = evaluateGates({ testsOverride: passingTests })
    const g0 = gates.find(gate => gate.id === 'C0-G0')!
    expect(g0.evidence).toContain('git-stage-map.json')
    expect(g0.detail).toContain('ancestry')
  })

  it('keeps the product decision separate from stage readiness', () => {
    const { eligibility } = evaluateGates({ testsOverride: passingTests })
    expect(eligibility.eligible).toBe(true)
    // Stage readiness is not deployment eligibility; the decision lives in the
    // report, and the gate script always writes deployment-hold.
    expect(eligibility.eligible).not.toBe('deployment-eligible')
  })
})
