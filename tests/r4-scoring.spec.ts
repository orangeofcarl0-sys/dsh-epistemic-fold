import { describe, expect, it } from 'vitest'
import { scoreReport, taskOutcomeOf, usageCompleteOf } from '../eval/r4/score.mjs'

const base = {
  schemaVersion: 1,
  checker: { pass: true, checks: [{ kind: 'json_equals', pass: true, detail: 'ok' }] },
  termination: { kind: 'finish', finished: false },
  witnessSummary: { committed: 0 },
  usage: { unknownUsage: 0, requests: 1, inputTokens: 10, outputTokens: 2 },
  requests: [{ usage: { inputTokens: 10, outputTokens: 2 } }],
}

describe('EF-R4 scoring split', () => {
  it('does not turn a mechanism miss into a task failure', () => {
    const score = scoreReport({
      report: {
        ...base,
        checker: {
          pass: false,
          checks: [
            { kind: 'json_equals', pass: true, detail: 'ok' },
            { kind: 'compactions', pass: false, detail: '1 committed, required 2' },
          ],
        },
        witnessSummary: { committed: 1 },
      },
      task: { requires: { minCompactions: 2 } },
      historicalPass: false,
    })
    expect(score.taskOutcome).toBe('correct')
    expect(score.historicalPass).toBe(false)
    expect(score.mechanism.requiredFoldCountMet).toBe(false)
  })

  it('classifies a step-limited failure as incomplete, not incorrect', () => {
    const score = scoreReport({
      report: {
        ...base,
        checker: { pass: false, checks: [{ kind: 'json_equals', pass: false, detail: 'missing' }] },
        termination: { kind: 'step-limit', finished: false },
      },
      task: {},
      historicalPass: false,
    })
    expect(score.taskOutcome).toBe('incomplete')
  })

  it('classifies a finished wrong answer as incorrect', () => {
    const score = scoreReport({
      report: {
        ...base,
        checker: { pass: false, checks: [{ kind: 'json_equals', pass: false, detail: 'wrong' }] },
        termination: { kind: 'finish', finished: true },
      },
      task: {},
      historicalPass: false,
    })
    expect(score.taskOutcome).toBe('incorrect')
  })

  it('keeps a correct task correct even when the step limit fired', () => {
    const score = scoreReport({
      report: { ...base, termination: { kind: 'step-limit', finished: false } },
      task: {},
      historicalPass: true,
    })
    expect(score.taskOutcome).toBe('correct')
    expect(score.termination.kind).toBe('step-limit')
  })

  it('treats a partial usage object as an incomplete cost', () => {
    expect(usageCompleteOf([{ usage: { inputTokens: 1, outputTokens: 2 } }])).toBe(true)
    expect(usageCompleteOf([{ usage: { inputTokens: null, outputTokens: 2 } }])).toBe(false)
    expect(usageCompleteOf([{ usage: null }])).toBe(false)
  })

  it('uses the v2 scoring block when present', () => {
    const score = scoreReport({
      report: {
        ...base,
        schemaVersion: 2,
        checker: { pass: false, checks: [{ kind: 'tests', pass: false, detail: 'red' }] },
        mechanism: { requiredCompactions: 2, committedCompactions: 2, requiredFoldCountMet: true },
        scoring: {
          taskOutcome: 'incomplete',
          termination: { finishCalled: false, kind: 'timeout' },
          cost: { usageCompleteR3: true, usageCompleteR4: false },
        },
        witnessSummary: { committed: 2 },
      },
      task: { requires: { minCompactions: 2 } },
      historicalPass: false,
    })
    expect(score.taskOutcome).toBe('incomplete')
    expect(score.mechanism.requiredFoldCountMet).toBe(true)
    expect(score.cost.usageCompleteR4).toBe(false)
  })

  it('has an explicit task-outcome precedence', () => {
    expect(taskOutcomeOf({ taskPass: true, finishCalled: false })).toBe('correct')
    expect(taskOutcomeOf({ taskPass: false, finishCalled: true })).toBe('incorrect')
    expect(taskOutcomeOf({ taskPass: false, finishCalled: false })).toBe('incomplete')
  })
})
