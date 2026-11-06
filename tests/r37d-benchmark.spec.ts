/**
 * R37-D WP6: benchmark certification and the held-out plan.
 *
 * @module tests/r37d-benchmark
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCase } from '../eval/r33/src/dataset.mjs'
import { validateCase } from '../eval/r33/src/schema.mjs'

const ROOT = process.cwd()
const h1 = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'h1-v2-audit.json'), 'utf8'))
const s1 = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 's1-v1-validity.json'), 'utf8'))
const plan = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'held-out-plan.json'), 'utf8'))

describe('R37-D H1-v2 audit', () => {
  it('keeps the gold out of the task, workspace, visible test, and handoff', () => {
    expect(h1.status).toBe('passed')
    expect(h1.leakage.taskNamesGold).toBe(false)
    expect(h1.leakage.workspaceNamesGold).toBe(false)
    expect(h1.leakage.visibleTestNamesGold).toBe(false)
    expect(h1.leakage.writerHandoffNamesGold).toBe(false)
    expect(h1.leakage.transcriptHasGold).toBe(true)
  })

  it('shows a plausible alternative passes visible and fails hidden', () => {
    expect(h1.runs.reference.visible.passed).toBe(true)
    expect(h1.runs.reference.hidden.allPassed).toBe(true)
    expect(h1.runs.alternative.visible.passed).toBe(true)
    expect(h1.runs.alternative.hidden.allPassed).toBe(false)
    expect(h1.historyNecessary).toBe(true)
  })
})

describe('R37-D S1-v1 certification', () => {
  it('validates against the case schema', async () => {
    const caseData = await loadCase('S1-v1', join(ROOT, 'eval', 'r37d', 'cases'))
    const result = validateCase(caseData)
    expect(result.ok).toBe(true)
  })

  it('keeps the production timeout out of the readable workspace', () => {
    expect(s1.status).toBe('certified')
    expect(s1.leakage.taskNamesGold).toBe(false)
    expect(s1.leakage.workspaceNamesGold).toBe(false)
    expect(s1.leakage.visibleTestNamesGold).toBe(false)
    expect(s1.leakage.writerHandoffNamesGold).toBe(false)
    expect(s1.leakage.transcriptHasGold).toBe(true)
  })

  it('separates the reference from the staging and alternative values', () => {
    expect(s1.runs.reference.visible.passed).toBe(true)
    expect(s1.runs.reference.hidden.allPassed).toBe(true)
    expect(s1.runs.stale.visible.passed).toBe(true)
    expect(s1.runs.stale.hidden.allPassed).toBe(false)
    expect(s1.runs.alternative.visible.passed).toBe(true)
    expect(s1.runs.alternative.hidden.allPassed).toBe(false)
    expect(s1.historyNecessary).toBe(true)
  })
})

describe('R37-D held-out plan', () => {
  it('has two certified cases and four specifications', () => {
    expect(plan.status).toBe('prepared')
    expect(plan.counts).toEqual({ certified: 2, specified: 4, total: 6 })
    expect(plan.cases.find((entry: any) => entry.id === 'H1-v2').status).toBe('certified')
    expect(plan.cases.find((entry: any) => entry.id === 'S1-v1').status).toBe('certified')
    for (const id of ['D2-v1', 'N1-v1', 'X1-v1', 'M1-v1']) {
      expect(plan.cases.find((entry: any) => entry.id === id).status).toBe('specified-not-authored')
    }
  })

  it('records a digest for every certified case component', () => {
    for (const entry of plan.cases.filter((item: any) => item.status === 'certified')) {
      for (const key of ['case', 'workspace', 'checker', 'reference', 'stale']) {
        expect(entry.digests[key]).toMatch(/^[a-f0-9]{64}$/u)
      }
    }
  })

  it('does not claim a live run', () => {
    expect(plan.noProviderCall).toBe(true)
    expect(plan.nextBatch.status).toBe('not-executed')
    expect(plan.freezeRequirements.length).toBeGreaterThanOrEqual(6)
  })
})
