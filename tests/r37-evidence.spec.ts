/**
 * R37-A1/A2: the R36 evidence reconstruction is reproducible and the new
 * failure taxonomy does not turn a harness defect into a memory failure.
 *
 * @module tests/r37-evidence
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  actualDelivery,
  firstObservableFailure,
  pairOutcome,
} from '../eval/r37/src/evidence.mjs'

const ROOT = process.cwd()
const reconstruction: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'r36-evidence-reconstruction.json'),
  'utf8',
))
const discrepancies: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'r36-evidence-discrepancies.json'),
  'utf8',
))

function rowFor(runId: string, arm: string): any {
  return reconstruction.runs.find((row: any) => row.runId === runId && row.arm === arm)
}

describe('R37-A1: R36 reconstruction', () => {
  it('reproduces the authoritative contract and task counts', () => {
    expect(reconstruction.summary.contract).toEqual({
      pairs: 12, rescue: 1, damage: 3, both: 4, neither: 4, invalid: 0,
    })
    expect(reconstruction.summary.task).toEqual({
      pairs: 12, rescue: 1, damage: 2, both: 5, neither: 4,
    })
  })

  it('is internally consistent and reports no score discrepancy', () => {
    expect(reconstruction.summary.integrity).toEqual({ rows: 36, ok: 36, failed: 0 })
    expect(discrepancies.status).toBe('no-discrepancy')
    expect(discrepancies.discrepancies).toEqual([])
    expect(discrepancies.notes.every((note: any) => note.kind === 'arm-not-run')).toBe(true)
  })

  it('separates assigned arm from actual delivery', () => {
    expect(actualDelivery({ arm: 'B1' })).toBe('ef-off-basic-context')
    expect(actualDelivery({ arm: 'O2' })).toBe('oracle-gold-facts')
    expect(actualDelivery({
      arm: 'S',
      fold: { valid: true },
      state: { commits: 1 },
      writer: { commitStatus: 'committed' },
    })).toBe('semantic-committed')
    expect(actualDelivery({
      arm: 'S',
      foldFallback: 'full-history',
      fold: { valid: false },
      state: { commits: 0 },
      writer: { commitStatus: 'fold-refused' },
    })).toBe('full-history-fallback')
    expect(actualDelivery({ arm: 'S', fold: { valid: true }, state: { commits: 0 } })).toBe('commit-missing')
    expect(actualDelivery({
      arm: 'FP',
      fixture: { variant: 'F-P' },
      fold: { valid: true, synthetic: true },
      state: { commits: 0 },
    })).toBe('controlled-oracle-facts')
  })

  it('keeps the C1 fallback out of the semantic-checkpoint population', () => {
    const c1r1 = rowFor('r36-causal-C1', 'S')
    expect(c1r1.assignedArm).toBe('S')
    expect(c1r1.actualDelivery).toBe('full-history-fallback')
    expect(c1r1.deliveryEvidence.foldFallback).toBe('full-history')
  })

  it('finds the B2 damage at the DSML content parameter, not at the decision', () => {
    const b2r1 = rowFor('r36-causal-B2', 'S')
    expect(b2r1.outcome.contractSuccess).toBe(false)
    expect(b2r1.failure.sufficientCause.kind).toBe('tool-parameter-corruption')
    expect(b2r1.workspace.escapedContentFiles).toEqual(['src/scheduler.mjs'])
    const pair = reconstruction.pairs.find((entry: any) => entry.caseId === 'B2' && entry.replicateId === 'r1')
    expect(pair.confounds.map((entry: any) => entry.kind)).toContain('tool-protocol')
    expect(pair.memoryAttribution).toBe('none')
  })

  it('classifies D1 r1 as an invalid artifact, not a missing one', () => {
    const d1r1b1 = rowFor('r36-causal-D1', 'B1')
    expect(d1r1b1.workspace.verificationJson.parsed.claim).toBe('failed')
    expect(d1r1b1.failure.first.kind).toBe('verification-artifact-invalid')
    const d1r2s = rowFor('r36-causal-r2-D1', 'S')
    expect(d1r2s.failure.first.kind).toBe('tool-parameter-loss')
  })

  it('marks A1 as a task/gold confound and D1 as a verification-process confound', () => {
    const a1 = reconstruction.pairs.find((entry: any) => entry.caseId === 'A1')
    const d1 = reconstruction.pairs.find((entry: any) => entry.caseId === 'D1')
    expect(a1.confounds.map((entry: any) => entry.kind)).toContain('task-gold-ambiguity')
    expect(d1.confounds.map((entry: any) => entry.kind)).toContain('verification-artifact-process')
  })
})

describe('R37-A2: pair outcome and first-failure rules', () => {
  it('computes rescue, damage, both and neither', () => {
    const select = (row: any) => row.success
    expect(pairOutcome({ valid: true, success: false }, { valid: true, success: true }, select)).toBe('rescue')
    expect(pairOutcome({ valid: true, success: true }, { valid: true, success: false }, select)).toBe('damage')
    expect(pairOutcome({ valid: true, success: true }, { valid: true, success: true }, select)).toBe('both')
    expect(pairOutcome({ valid: true, success: false }, { valid: true, success: false }, select)).toBe('neither')
    expect(pairOutcome({ valid: false, success: true }, { valid: true, success: false }, select)).toBe('invalid')
  })

  it('treats an escaped final workspace as observed evidence, not an inference', () => {
    const failure = firstObservableFailure({
      caseData: { id: 'B2', gold: [], transcript: [], requiresTests: true },
      row: {
        arm: 'S',
        writer: { call: 'success', protocol: 'parsed' },
        fold: { valid: true },
        state: { commits: 1 },
        behaviour: { failedChecks: ['module-load:src/scheduler.mjs'] },
      },
      trace: {},
      replay: {
        actions: [{ tool: 'run_tests', step: 4 }],
        writeActions: [],
        writeActionsMissingContent: [],
        writeActionsCorrupted: [],
        unknownTools: [],
        testActions: [{ step: 4 }],
        truncatedSteps: [],
        unclosedInvokeSteps: [],
        partialWritePrefixSteps: [],
        turnTextCapChars: 1000,
      },
      workspace: {
        initialDigest: 'a',
        finalDigest: 'b',
        verificationJson: null,
        escapedContentFiles: ['src/scheduler.mjs'],
      },
    })
    expect(failure.first.kind).toBe('tool-parameter-corruption')
    expect(failure.first.confidence).toBe('observed-in-final-workspace')
    expect(failure.sufficientCause.kind).toBe('tool-parameter-corruption')
  })

  it('does not treat a truncated trace prefix as a parse failure', () => {
    const failure = firstObservableFailure({
      caseData: { id: 'C1', gold: [], transcript: [], requiresTests: true },
      row: {
        arm: 'B1',
        writer: {},
        fold: { valid: true },
        state: {},
        behaviour: { failedChecks: ['functionality.delivers-change'] },
      },
      trace: {},
      replay: {
        actions: [{ tool: 'run_tests', step: 1 }],
        writeActions: [],
        writeActionsMissingContent: [],
        writeActionsCorrupted: [],
        unknownTools: [],
        testActions: [{ step: 1 }],
        truncatedSteps: [1],
        unclosedInvokeSteps: [1],
        partialWritePrefixSteps: [],
        turnTextCapChars: 1000,
      },
      workspace: {
        initialDigest: 'a',
        finalDigest: 'a',
        verificationJson: null,
        escapedContentFiles: [],
      },
    })
    expect(failure.candidates.some((candidate: any) => candidate.kind === 'tool-parse-failure')).toBe(false)
    expect(failure.unresolved.some((entry: any) => entry.kind === 'unclosed-invoke-prefix')).toBe(true)
    expect(failure.sufficientCause.kind).toBe('implementation-failure')
  })

  it('classifies an invalid D1 claim vocabulary as an invalid artifact', () => {
    const failure = firstObservableFailure({
      caseData: { id: 'D1', gold: [], transcript: [], requiresTests: true },
      row: {
        arm: 'S',
        writer: { call: 'success', protocol: 'parsed' },
        fold: { valid: true },
        state: { commits: 1 },
        behaviour: { failedChecks: ['constraint.claim-known'] },
      },
      trace: {},
      replay: {
        actions: [{ tool: 'run_tests', step: 2 }],
        writeActions: [{ step: 2 }],
        writeActionsMissingContent: [],
        writeActionsCorrupted: [],
        unknownTools: [],
        testActions: [{ step: 2 }],
        truncatedSteps: [],
        unclosedInvokeSteps: [],
        partialWritePrefixSteps: [],
        turnTextCapChars: 1000,
      },
      workspace: {
        initialDigest: 'a',
        finalDigest: 'b',
        verificationJson: { parseError: null, parsed: { claim: 'not verified' } },
        escapedContentFiles: [],
      },
    })
    expect(failure.first.kind).toBe('verification-artifact-invalid')
    expect(failure.sufficientCause.kind).toBe('verification-artifact-invalid')
  })
})
