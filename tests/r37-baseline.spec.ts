/**
 * R37-A0: the baseline manifest identifies the real R36 endpoint and the
 * rebuilt test baseline. It does not treat a missing build artifact as a code
 * regression or a test-generated file as a source change.
 *
 * @module tests/r37-baseline
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const baseline: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'baseline-manifest.json'),
  'utf8',
))

describe('R37-A0: baseline integrity', () => {
  it('records the verified R36 HEAD as the base', () => {
    expect(baseline.repository.baseCommit).toBe('b8274bba8b2a974e9c75af283e415e61a650295e')
    expect(baseline.repository.branch).toBe('rc37-semantic-action')
    expect(baseline.repository.r36Worktree.head).toBe(baseline.repository.baseCommit)
    expect(baseline.repository.r36Worktree.status).toEqual([])
  })

  it('records the frozen dataset and the six behavioural cases', () => {
    expect(baseline.dataset.id).toBe('r33-semantic-continuity-v2')
    expect(baseline.dataset.digest).toBe('407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f')
    expect(baseline.dataset.frozenDigest).toBe(baseline.dataset.digest)
    expect(baseline.dataset.matches).toBe(true)
    expect(baseline.dataset.cases.map((entry: any) => entry.id)).toEqual(['A1', 'B2', 'C1', 'D1', 'F1', 'H1'])
  })

  it('records every R36 authoritative file and all 12 causal runs', () => {
    const files = Object.values(baseline.historicalEvidence.files) as any[]
    expect(files.length).toBe(32)
    expect(files.every(file => file.present === true)).toBe(true)
    const runs = baseline.historicalEvidence.runArchive.runs as any[]
    expect(runs.length).toBe(12)
    expect(runs.every(run => run.present === true)).toBe(true)
    expect(runs.filter(run => Object.keys(run.arms).length === 4).length).toBe(6)
    expect(runs.filter(run => Object.keys(run.arms).length === 2).length).toBe(6)
  })

  it('reproduces the R36 test baseline instead of hiding it', () => {
    const commands = baseline.tests.commands as any[]
    const byName = (name: string) => commands.find(command => command.command === name)
    expect(byName('npm run typecheck').exitCode).toBe(0)
    expect(byName('npm run eval:r33').vitest.passed).toBe(94)
    expect(byName('npm run eval:r36-tests').vitest.passed).toBe(34)
    const full = byName('npm run test')
    expect(full.vitest.passed).toBe(1476)
    expect(full.vitest.failed).toBe(12)
    expect(full.vitest.skipped).toBe(70)
  })

  it('distinguishes test-generated changes from the R37 source changes', () => {
    const generated = baseline.repository.testGeneratedChanges as string[]
    expect(generated).toContain(' M docs/MANIFEST.json')
    expect(generated.some(line => line.includes('ef-phase7-logs/watchdog.heartbeat'))).toBe(true)
    expect(generated.some(line => line.includes('eval/r37/'))).toBe(false)
  })
})
