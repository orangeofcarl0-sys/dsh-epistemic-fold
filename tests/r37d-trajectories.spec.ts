/**
 * R37-D process-pilot trajectory assertions.
 *
 * @module tests/r37d-trajectories
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const report = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'process-pilot-trajectories.json'), 'utf8'))
const cells = report.cells as any[]

function cell(id: string): any {
  const found = cells.find(entry => entry.cellId === `r37d-process-${id}`)
  if (found === undefined) throw new Error(`cell not found: ${id}`)
  return found
}

describe('R37-D process trajectories', () => {
  it('accounts all 24 cells and the six archetypes', () => {
    expect(cells).toHaveLength(24)
    expect(report.archetypes).toEqual({
      'test-no-finish': 9,
      'finish-with-artifact': 7,
      'protocol-stall-no-test': 5,
      'finish-with-test': 1,
      'finish-with-inconsistent-artifact': 1,
      'finish-without-artifact': 1,
    })
  })

  it('attributes every operational failure', () => {
    expect(report.failures).toHaveLength(7)
    expect(report.failures.map((failure: any) => failure.cellId).sort()).toEqual([
      'r37d-process-B2-B1-P1-r2',
      'r37d-process-B2-S-P0-r3',
      'r37d-process-B2-S-P1-r1',
      'r37d-process-B2-S-P1-r2',
      'r37d-process-D1-v2-B1-P0-r1',
      'r37d-process-D1-v2-B1-P0-r3',
      'r37d-process-D1-v2-S-P0-r1',
    ])
  })

  it('shows D1 P1 produces six consistent artifacts and B2 produces none', () => {
    const d1p1 = cells.filter(entry => entry.caseId === 'D1-v2' && entry.condition === 'P1')
    const b2p1 = cells.filter(entry => entry.caseId === 'B2' && entry.condition === 'P1')
    expect(d1p1.filter(entry => entry.verification.artifactPresent)).toHaveLength(6)
    expect(d1p1.filter(entry => entry.verification.selfReportConsistent === true)).toHaveLength(6)
    expect(b2p1.filter(entry => entry.verification.artifactPresent)).toHaveLength(0)
  })

  it('separates the two D1 P0 artifact failures', () => {
    const inconsistent = cell('D1-v2-B1-P0-r3')
    expect(inconsistent.archetype).toBe('finish-with-inconsistent-artifact')
    expect(inconsistent.counts.testsExecuted).toBe(1)
    expect(inconsistent.verification.testsRun).toBe(0)
    expect(inconsistent.verification.selfReportConsistent).toBe(false)

    const missing = cell('D1-v2-S-P0-r1')
    expect(missing.archetype).toBe('finish-without-artifact')
    expect(missing.counts.testsExecuted).toBe(2)
    expect(missing.verification.artifactPresent).toBe(false)
    expect(missing.verification.writeMentions).toBe(0)
  })

  it('shows B2 failures are protocol stalls with no test and no write', () => {
    const b2Failures = report.failures.filter((failure: any) => failure.cellId.includes('-B2-'))
    expect(b2Failures).toHaveLength(4)
    for (const failure of b2Failures) {
      expect(failure.archetype).toBe('protocol-stall-no-test')
      expect(failure.tests).toBe(0)
      expect(failure.finishRequests).toBe(0)
      expect(failure.noValidActionCalls).toBeGreaterThanOrEqual(4)
      expect(failure.toolSequence).not.toContain('run_tests')
      expect(failure.toolSequence).not.toContain('write_file')
    }
  })

  it('records the case-dependent P0/P1 behavior change', () => {
    expect(report.p0p1['D1-v2/B1'].testsPerCell).toEqual({ p0: 2 / 3, p1: 2 })
    expect(report.p0p1['D1-v2/S'].verificationArtifacts).toEqual({ p0: 2, p1: 3 })
    expect(report.p0p1['B2/B1'].testsPerCell).toEqual({ p0: 7 / 3, p1: 4 / 3 })
    expect(report.p0p1['B2/S'].invalidPerCell).toEqual({ p0: 13 / 3, p1: 5 })
  })

  it('does not claim a significance result', () => {
    expect(report.conclusions.join(' ')).toMatch(/exploratory/u)
    expect(report.conclusions.join(' ')).toMatch(/three replicates/u)
  })
})
