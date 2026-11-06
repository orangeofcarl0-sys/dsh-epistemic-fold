/**
 * R37-C0-C: a fold refusal is a pipeline outcome, not a censored measurement.
 *
 * @module tests/r37c-measurement
 */

import { describe, expect, it } from 'vitest'
import {
  assignedArmSummary,
  classifyRow,
  measurementStatus,
  pipelineOutcome,
} from '../eval/r37c/src/measurement.mjs'

function row(overrides: any = {}) {
  return {
    arm: 'S',
    valid: true,
    measurementValid: true,
    failures: {
      provider: [],
      budget: [],
      checker: [],
      harness: [],
      fold: [],
      task: { assessed: false },
    },
    fold: { valid: true },
    state: { commits: 1, anchors: ['a fact'] },
    writer: { commitStatus: 'committed' },
    behaviour: {},
    ...overrides,
  }
}

describe('R37-C0-C: measurement vs pipeline', () => {
  it('classifies a fold refusal as a valid measurement of a fold-refused pipeline', () => {
    const value = row({
      valid: false,
      measurementValid: false,
      failures: {
        provider: [], budget: [], checker: [], harness: [],
        fold: [{ kind: 'fold-refused', reason: 'summary-not-smaller' }],
        task: { assessed: false },
      },
      fold: { valid: false },
      state: { commits: 0, anchors: [] },
      writer: { commitStatus: 'fold-refused' },
    })
    expect(measurementStatus(value)).toBe('valid')
    expect(pipelineOutcome(value)).toBe('fold-refused')
    expect(classifyRow(value).scored).toBe(true)
  })

  it('classifies a provider transport failure as censored', () => {
    const value = row({
      valid: false,
      measurementValid: false,
      failures: {
        provider: [{ kind: 'provider-transport-error', code: 'LIVE_TRANSPORT' }],
        budget: [], checker: [], harness: [], fold: [],
        task: { assessed: false },
      },
      fold: null,
      state: null,
      writer: { commitStatus: 'not-applicable' },
    })
    expect(measurementStatus(value)).toBe('provider-invalid')
    expect(classifyRow(value).scored).toBe(false)
  })

  it('classifies a budget refusal as censored', () => {
    const value = row({
      valid: false,
      measurementValid: false,
      failures: {
        provider: [],
        budget: [{ kind: 'budget-exhausted' }],
        checker: [], harness: [], fold: [],
        task: { assessed: false },
      },
    })
    expect(measurementStatus(value)).toBe('budget-censored')
  })

  it('keeps a fallback in the assigned-arm denominator', () => {
    const value = row({ foldFallback: 'full-history', fold: { valid: false }, state: { commits: 0 } })
    expect(pipelineOutcome(value)).toBe('full-history-fallback')
    const summary = assignedArmSummary([value])
    expect(summary.S.rows).toBe(1)
    expect(summary.S.pipeline['full-history-fallback']).toBe(1)
  })

  it('distinguishes an empty commit', () => {
    const value = row({ state: { commits: 1, anchors: [] } })
    expect(pipelineOutcome(value)).toBe('empty-commit')
  })

  it('labels a controlled fixture as oracle facts', () => {
    const value = row({ arm: 'FS', fixture: { variant: 'F-S' }, fold: { valid: true, synthetic: true }, state: { commits: 0 } })
    expect(pipelineOutcome(value)).toBe('controlled-oracle-facts')
  })

  it('counts provider-invalid rows separately from task failures', () => {
    const foldRefused = row({
      valid: false,
      measurementValid: false,
      failures: {
        provider: [], budget: [], checker: [], harness: [],
        fold: [{ kind: 'fold-refused' }],
        task: { assessed: false },
      },
      fold: { valid: false },
      state: { commits: 0 },
      writer: { commitStatus: 'fold-refused' },
    })
    const provider = row({
      valid: false,
      measurementValid: false,
      failures: {
        provider: [{ kind: 'provider-transport-error' }],
        budget: [], checker: [], harness: [], fold: [],
        task: { assessed: false },
      },
    })
    const summary = assignedArmSummary([foldRefused, provider])
    expect(summary.S.rows).toBe(2)
    expect(summary.S.valid).toBe(1)
    expect(summary.S.providerInvalid).toBe(1)
  })
})
