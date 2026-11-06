/**
 * R37-C0-D: a partial or unverifiable gate must not exit 0.
 *
 * @module tests/r37c-gates
 */

import { describe, expect, it } from 'vitest'
import {
  exitCodeFor,
  gateEvaluation,
  machineProductOutcome,
} from '../eval/r37c/src/gate-exit.mjs'

describe('R37-C0-D: gate exit semantics', () => {
  it('exits 0 only when every gate passed', () => {
    expect(exitCodeFor([{ id: 'a', status: 'passed' }, { id: 'b', status: 'passed' }])).toBe(0)
  })

  it('exits 2 for partial, not-executed, blocked, or not-verifiable', () => {
    for (const status of ['partial', 'not-executed', 'blocked', 'gate-not-verifiable', 'incomplete', 'unknown']) {
      expect(exitCodeFor([{ id: 'a', status }])).toBe(2)
    }
  })

  it('exits 1 for a failed gate even if another gate is partial', () => {
    expect(exitCodeFor([{ id: 'a', status: 'failed' }, { id: 'b', status: 'partial' }])).toBe(1)
  })

  it('separates evaluated, passed, and eligible', () => {
    const evaluation = gateEvaluation([
      { id: 'a', status: 'passed' },
      { id: 'b', status: 'gate-not-verifiable' },
    ])
    expect(evaluation.evaluated).toBe(2)
    expect(evaluation.passed).toBe(1)
    expect(evaluation.eligible).toBe(false)
    expect(evaluation.nonPassIds).toEqual(['b'])
  })

  it('computes the harm signal without a researcher variable', () => {
    expect(machineProductOutcome({ rescue: 1, damage: 9, p: 0.0215, deliveryRate: 0.97 })).toBe('active-harm-signal')
    expect(machineProductOutcome({ rescue: 9, damage: 1, p: 0.0215, deliveryRate: 0.97 })).toBe('active-benefit-signal')
    expect(machineProductOutcome({ rescue: 9, damage: 1, p: 0.0215, deliveryRate: 0.5 })).toBe('insufficient-evidence')
    expect(machineProductOutcome({ rescue: 2, damage: 2, p: 0.5, deliveryRate: 0.97 })).toBe('insufficient-evidence')
  })
})
