/**
 * R37-D WP4: the process batch is frozen, preflighted, and not authorized.
 *
 * @module tests/r37d-pilot
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const manifest = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'process-pilot-manifest.json'), 'utf8'))
const preflight = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'process-pilot-preflight.json'), 'utf8'))
const results = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'process-pilot-results.json'), 'utf8'))
const analysis = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'process-pilot-analysis.json'), 'utf8'))

describe('R37-D process pilot manifest', () => {
  it('freezes 24 cells across two cases, two arms, two prompts, three replicates', () => {
    expect(manifest.design.cells).toBe(24)
    expect(manifest.cells).toHaveLength(24)
    const counts: Record<string, number> = {}
    for (const cell of manifest.cells) {
      const key = `${cell.caseId}/${cell.arm}/${cell.condition}`
      counts[key] = (counts[key] ?? 0) + 1
    }
    expect(Object.keys(counts)).toHaveLength(8)
    expect(Object.values(counts).every(count => count === 3)).toBe(true)
  })

  it('holds the guard off and the budget fixed', () => {
    for (const cell of manifest.cells) {
      expect(cell.guard).toBe(false)
      expect(cell.steps).toBe(8)
      expect(cell.outputTokens).toBe(1024)
      expect(cell.toolProtocol).toBe('P3s')
      expect(cell.runtime).toBe('custom-json-loop')
      expect(cell.scorerVersion).toBe(3)
    }
  })

  it('uses an empty P0 and a generic P1', () => {
    expect(manifest.prompts.P0.text).toBe('')
    expect(manifest.prompts.P1.text.length).toBeGreaterThan(0)
    expect(manifest.prompts.P1.text).toMatch(/verification steps/u)
    expect(manifest.prompts.P1.text).toMatch(/deliverables/u)
  })

  it('does not put a gold phrase in P1', () => {
    const p1 = manifest.prompts.P1.text.toLowerCase()
    expect(p1).not.toMatch(/eu-west-2/u)
    expect(p1).not.toMatch(/in-memory queue/u)
    expect(p1).not.toMatch(/tests have not been run/u)
  })

  it('binds every cell to the frozen fixture and task digest', () => {
    for (const cell of manifest.cells) {
      expect(cell.fixture).toMatch(/^eval\/r37d\/fixtures\//u)
      expect(cell.fixtureDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(cell.taskDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(cell.workspaceDigest).toMatch(/^[a-f0-9]{64}$/u)
    }
  })
})

describe('R37-D process pilot preflight', () => {
  it('is ready for authorization, not authorized', () => {
    expect(preflight.status).toBe('ready-for-authorization')
    expect(preflight.authorization.granted).toBe(false)
    expect(preflight.noProviderCall).toBe(true)
    expect(preflight.runner.status).toBe('available')
  })

  it('has no failed check', () => {
    expect(preflight.checks.filter((check: any) => check.status === 'failed')).toEqual([])
    expect(preflight.checks.find((check: any) => check.id === 'authorization').status).toBe('partial')
    expect(preflight.checks.find((check: any) => check.id === 'runner').status).toBe('passed')
  })

  it('keeps the planning caps at the preregistered values', () => {
    expect(manifest.limits).toEqual({
      httpAttempts: 240,
      inputTokens: 300_000,
      outputTokens: 70_000,
      wallClockMs: 3_600_000,
    })
  })
})

describe('R37-D process pilot execution', () => {
  it('executed all 24 cells inside every cap', () => {
    expect(results.status).toBe('complete')
    expect(results.stopReason).toBe(null)
    expect(results.summary.executed).toBe(24)
    expect(results.summary.measurements).toEqual({ valid: 24 })
    expect(results.budget.used.requests).toBeLessThanOrEqual(240)
    expect(results.budget.used.inputTokens).toBeLessThanOrEqual(300_000)
    expect(results.budget.used.outputTokens).toBeLessThanOrEqual(70_000)
    expect(results.budget.used.wallClockMs).toBeLessThanOrEqual(3_600_000)
    expect(results.authorization.granted).toBe(true)
  })

  it('records the case-dependent prompt effect', () => {
    expect(results.summary.legacyContractSuccesses).toBe(17)
    expect(results.summary.operationalCompletions).toBe(17)
    expect(results.summary.strictFinish).toBe(8)
    expect(analysis.effects.promptUnderB1.operational.rateDifference).toBeCloseTo(1 / 6, 12)
    expect(analysis.effects.promptUnderS.operational.rateDifference).toBe(0)
    expect(analysis.effects.interaction.operationalRateDifference).toBeCloseTo(-1 / 6, 12)
    expect(analysis.conditions['D1-v2/B1/P1'].operational).toBe(3)
    expect(analysis.conditions['B2/B1/P1'].operational).toBe(2)
  })

  it('does not turn the pilot into a product benefit', () => {
    expect(analysis.conclusions.join(' ')).toMatch(/No significance claim/u)
    expect(results.notes.join(' ')).toMatch(/fixed context/u)
  })
})
