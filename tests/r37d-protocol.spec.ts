/**
 * R37-D WP2: action accounting and multi-action ordering.
 *
 * @module tests/r37d-protocol
 */

import { describe, expect, it } from 'vitest'
import { splitFinishActions } from '../eval/r33/src/action-order.mjs'
import { accountTurn, summarizeCell } from '../eval/r37d/src/action-accounting.mjs'
import { encodeParameterWrite } from '../eval/r37c/src/dsml-codec.mjs'

function turn(text: string, kind = 'stop', step = 0): any {
  return { turn: { step, text, finishReason: { kind } }, maxSteps: 8, index: step }
}

describe('R37-D multi-action contract', () => {
  it('preserves the model order of non-finish actions', () => {
    const actions = [{ tool: 'read_file' }, { tool: 'write_file' }, { tool: 'run_tests' }]
    const result = splitFinishActions(actions)
    expect(result.nonFinish.map(action => action.tool)).toEqual(['read_file', 'write_file', 'run_tests'])
    expect(result.finish).toBe(null)
    expect(result.finishPosition).toBe(-1)
  })

  it('moves a finish that was emitted first to the end of execution', () => {
    const actions = [{ tool: 'finish' }, { tool: 'write_file' }]
    const result = splitFinishActions(actions)
    expect(result.nonFinish.map(action => action.tool)).toEqual(['write_file'])
    expect(result.finish?.tool).toBe('finish')
    expect(result.finishPosition).toBe(0)
    expect([...result.nonFinish.map(action => action.tool), 'finish']).toEqual(['write_file', 'finish'])
  })

  it('keeps a finish in the middle after the remaining non-finish actions', () => {
    const actions = [{ tool: 'read_file' }, { tool: 'finish' }, { tool: 'write_file' }]
    const result = splitFinishActions(actions)
    expect(result.nonFinish.map(action => action.tool)).toEqual(['read_file', 'write_file'])
    expect(result.finishPosition).toBe(1)
  })

  it('uses only the first finish when a turn repeats it', () => {
    const actions = [{ tool: 'finish', summary: 'first' }, { tool: 'finish', summary: 'second' }]
    const result = splitFinishActions(actions)
    expect(result.finish?.summary).toBe('first')
    expect(result.nonFinish).toEqual([])
  })
})

describe('R37-D per-turn action accounting', () => {
  it('accounts a valid write turn as dispatched with a result', () => {
    const text = `I will write the file.\n${encodeParameterWrite({ path: 'src/a.mjs', content: 'export const a = 1\n' })}`
    const accounted = accountTurn(turn(text))
    expect(accounted.toolRequestEmitted).toBe(true)
    expect(accounted.toolRequestParsed).toBe(true)
    expect(accounted.toolRequestValidated).toBe(true)
    expect(accounted.toolRequestDispatched).toBe(true)
    expect(accounted.toolResultReceived).toBe(true)
    expect(accounted.actions[0].tool).toBe('write_file')
    expect(accounted.actions[0].path).toBe('src/a.mjs')
    expect(accounted.noValidAction).toBe(false)
    expect(accounted.evidence).toBe('complete')
  })

  it('classifies an unclosed DSML invoke as invalid-envelope, not truncated-output', () => {
    const text = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="write_file">\n<｜｜DSML｜｜ path="verification.json">\n<｜｜DSML｜｜ content="{'
    const accounted = accountTurn(turn(text, 'stop'))
    expect(accounted.noValidAction).toBe(true)
    expect(accounted.noValidActionClass).toBe('invalid-envelope')
    expect(accounted.responseTruncated).toBe(false)
  })

  it('classifies provider max-tokens as truncated-output', () => {
    const text = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="write_file">\n<｜｜DSML｜｜ path="verification.json">'
    const accounted = accountTurn(turn(text, 'max-tokens'))
    expect(accounted.noValidAction).toBe(true)
    expect(accounted.noValidActionClass).toBe('truncated-output')
    expect(accounted.responseTruncated).toBe(true)
  })

  it('classifies a read without a path as missing-parameter', () => {
    const text = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_file">\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
    const accounted = accountTurn(turn(text, 'stop'))
    expect(accounted.noValidAction).toBe(true)
    expect(accounted.noValidActionClass).toBe('missing-parameter')
  })

  it('classifies natural language with no tool marker as natural-language-only', () => {
    const accounted = accountTurn(turn('I will inspect the workspace first.', 'stop'))
    expect(accounted.noValidAction).toBe(true)
    expect(accounted.noValidActionClass).toBe('natural-language-only')
    expect(accounted.toolRequestEmitted).toBe(false)
  })

  it('marks a capped prefix without a diagnostic as unavailable-evidence', () => {
    const accounted = accountTurn(turn('x'.repeat(1000), 'stop'))
    expect(accounted.responseCapped).toBe(true)
    expect(accounted.noValidAction).toBe(true)
    expect(accounted.noValidActionClass).toBe('unavailable-evidence')
    expect(accounted.evidence).toBe('stored-prefix')
  })

  it('accounts the finish position without executing it in the tool sequence', () => {
    const text = '{"tool":"read_file","path":"a.mjs"}\n{"tool":"finish","summary":"done"}'
    const accounted = accountTurn(turn(text, 'stop'))
    expect(accounted.actions.map((action: any) => action.tool)).toEqual(['read_file', 'finish'])
    expect(accounted.finishRequested).toBe(true)
    expect(accounted.finishPosition).toBe(1)
    expect(accounted.toolResultReceived).toBe(true)
  })
})

describe('R37-D per-cell budget accounting', () => {
  it('reports the call budget before the first write and test', () => {
    const turns = [
      { ...accountTurn(turn('{"tool":"read_file","path":"a.mjs"}', 'stop', 0)) },
      { ...accountTurn(turn('{"tool":"read_file","path":"a.mjs"}', 'stop', 1)) },
      { ...accountTurn(turn('{"tool":"run_tests"}', 'stop', 2)) },
      { ...accountTurn(turn(encodeParameterWrite({ path: 'verification.json', content: '{"claim":"not-verified"}' }), 'stop', 3)) },
      { ...accountTurn(turn('{"tool":"finish","summary":"done"}', 'stop', 4)) },
    ]
    const summary = summarizeCell({
      cell: { cellId: 'x', caseId: 'D1-v2', arm: 'B1', guard: 'G0', replicateId: 'r1' },
      turns,
      detail: { modelCalls: 5, steps: 4, toolCalls: 3, testsExecuted: 1, finishGuard: { finishRequests: 1 } },
      harness: { maxSteps: 8, validActions: 5, rejectedActions: 0, invalidActions: 0, stepLimitTermination: false },
      verificationArtifact: true,
      requiresVerificationArtifact: true,
    })
    expect(summary.modelCallsBeforeFirstWrite).toBe(3)
    expect(summary.modelCallsBeforeFirstTest).toBe(2)
    expect(summary.remainingBudgetAtFirstTest).toBe(5)
    expect(summary.modelCallsAfterLastWrite).toBe(1)
    expect(summary.legalCodeNoTest).toBe(false)
    expect(summary.verificationFailurePhase).toBe('executed')
  })

  it('distinguishes a rejected verification write from a missing request', () => {
    const rejected = [
      { ...accountTurn(turn('{"tool":"run_tests"}', 'stop', 0)) },
      { ...accountTurn(turn('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="write_file">\n<｜｜DSML｜｜ path="verification.json">\n<｜｜DSML｜｜ content="{', 'stop', 1)) },
    ]
    const rejectedSummary = summarizeCell({
      cell: { cellId: 'rejected', caseId: 'D1-v2', arm: 'B1', guard: 'G1', replicateId: 'r1' },
      turns: rejected,
      detail: { modelCalls: 2, steps: 2, toolCalls: 1, testsExecuted: 1, finishGuard: { finishRequests: 0 } },
      harness: { maxSteps: 8, validActions: 1, rejectedActions: 0, invalidActions: 1, stepLimitTermination: true },
      verificationArtifact: false,
      requiresVerificationArtifact: true,
    })
    expect(rejectedSummary.verificationWriteMentions).toBe(1)
    expect(rejectedSummary.verificationWriteValid).toBe(0)
    expect(rejectedSummary.verificationFailurePhase).toBe('tool-request-rejected')

    const never = [
      { ...accountTurn(turn('{"tool":"run_tests"}', 'stop', 0)) },
      { ...accountTurn(turn('{"tool":"read_file","path":"src/a.mjs"}', 'stop', 1)) },
    ]
    const neverSummary = summarizeCell({
      cell: { cellId: 'never', caseId: 'D1-v2', arm: 'S', guard: 'G1', replicateId: 'r1' },
      turns: never,
      detail: { modelCalls: 2, steps: 2, toolCalls: 2, testsExecuted: 1, finishGuard: { finishRequests: 0 } },
      harness: { maxSteps: 8, validActions: 2, rejectedActions: 0, invalidActions: 0, stepLimitTermination: true },
      verificationArtifact: false,
      requiresVerificationArtifact: true,
    })
    expect(neverSummary.verificationWriteMentions).toBe(0)
    expect(neverSummary.verificationFailurePhase).toBe('budget-exhausted-before-request')
  })
})
