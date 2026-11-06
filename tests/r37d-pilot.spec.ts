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
    expect(preflight.runner.status).toBe('design-only')
  })

  it('has no failed check', () => {
    expect(preflight.checks.filter((check: any) => check.status === 'failed')).toEqual([])
    expect(preflight.checks.find((check: any) => check.id === 'authorization').status).toBe('partial')
    expect(preflight.checks.find((check: any) => check.id === 'runner').status).toBe('partial')
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
