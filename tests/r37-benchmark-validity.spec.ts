/**
 * R37-A4: A1-v2/D1-v2 are versioned, certified, and do not reinterpret R36.
 *
 * @module tests/r37-benchmark-validity
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const validity: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'benchmark-validity.json'),
  'utf8',
))
const baseline: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'baseline-manifest.json'),
  'utf8',
))
const a1Case: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'cases', 'A1-v2', 'case.json'),
  'utf8',
))
const d1Case: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'cases', 'D1-v2', 'case.json'),
  'utf8',
))

describe('R37-A4: benchmark validity', () => {
  it('certifies both versioned cases and their negative controls', () => {
    expect(validity.status).toBe('passed')
    expect(validity.cases.map((entry: any) => entry.caseId)).toEqual(['A1-v2', 'D1-v2'])
    for (const caseRow of validity.cases) {
      expect(caseRow.certified).toBe(true)
      expect(caseRow.reference.visible.exitCode).toBe(0)
      expect(caseRow.reference.hidden.exitCode).toBe(0)
      expect(caseRow.counterfactual.expectedFailureObserved).toBe(true)
    }
  })

  it('states the A1 string-form requirement in the task and visible test', () => {
    expect(a1Case.task).toMatch(/string form/u)
    expect(a1Case.task).toMatch(/retries:\s*2/u)
    const visible = readFileSync(
      join(ROOT, 'eval', 'r37', 'cases', 'A1-v2', 'workspace', 'tests', 'config.test.mjs'),
      'utf8',
    )
    expect(visible).toMatch(/loadConfig\('config\.json'\)/u)
    expect(visible).toMatch(/retries/u)
    expect(validity.cases[0].taskStatesStringFormRetries).toBe(true)
    expect(validity.cases[0].visibleTestCoversStringForm).toBe(true)
  })

  it('states the D1 artifact and claim vocabulary in the task', () => {
    expect(d1Case.task).toMatch(/verification\.json/u)
    expect(d1Case.task).toMatch(/verified/u)
    expect(d1Case.task).toMatch(/not-verified/u)
    expect(validity.cases[1].taskStatesArtifact).toBe(true)
    expect(validity.cases[1].taskStatesClaimVocabulary).toBe(true)
  })

  it('preserves the old A1/D1 bytes and R36 scores', () => {
    expect(validity.historicalPreservation.oldCasesUnchanged).toBe(true)
    expect(validity.historicalPreservation.oldDigests.A1).toBe(validity.historicalPreservation.oldDigests.baselineA1)
    expect(validity.historicalPreservation.oldDigests.D1).toBe(validity.historicalPreservation.oldDigests.baselineD1)
    expect(validity.historicalPreservation.oldScores.A1.length).toBe(2)
    expect(validity.historicalPreservation.oldScores.D1.length).toBe(2)
    expect(baseline.dataset.cases.find((entry: any) => entry.id === 'A1').digest).toBe(
      validity.historicalPreservation.oldDigests.A1,
    )
  })

  it('does not pool the old and new cases', () => {
    expect(a1Case.id).toBe('A1-v2')
    expect(d1Case.id).toBe('D1-v2')
    expect(a1Case.versionProvenance.supersedes).toBe('A1')
    expect(d1Case.versionProvenance.supersedes).toBe('D1')
    expect(validity.historicalPreservation.note).toMatch(/not pooled/u)
  })
})
