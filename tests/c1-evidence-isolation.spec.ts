/**
 * EF-C1 WP1 — ordinary commands must not rewrite protected artifacts.
 *
 * ## What this pins
 *
 * EF-C0 found the defect by accident: the full Vitest suite rewrote
 * `docs/12_R1_EVALUATION_REPORT.md`, `docs/MANIFEST.json` and four files under
 * `eval/r33/out/`. A later `git status` looked clean only because the files had
 * been restored by hand. "The tests are read-only" is therefore not a claim
 * this repository gets to make without measuring it.
 *
 * The measurement lives in `eval/c1/observe.mjs` and its results in
 * `eval/c1/out/observation-*.json`. This test re-derives the property at run
 * time for the commands that can be run cheaply and safely:
 *
 *   - the protected registry must be internally consistent (worktree == HEAD);
 *   - `generate-presets --check`, `generate-maps --check` and the docs-manifest
 *     default must leave every protected hash unchanged;
 *   - the side-effect inventory must have no unclassified repository-shaped
 *     write;
 *   - every historical report declared in `report-baselines.json` must still
 *     match its frozen hash.
 *
 * It does NOT run `npm ci` or the full suite (the observation harness does
 * that, once, with a before/after snapshot). Re-running those here would make
 * every test run pay for the certification.
 *
 * @module tests/c1-evidence-isolation
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DATA = join(ROOT, 'eval', 'c1', 'out')

interface ProtectedEntry {
  readonly path: string
  readonly category: string
  readonly headSha256: string
  readonly worktreeSha256: string
  readonly worktreeMatchesHead: boolean
}

interface ProtectedRegistry {
  readonly counts: {
    readonly total: number
    readonly drifted: number
    readonly driftedFrozen: number
    readonly driftedGenerated: number
  }
  readonly entries: readonly ProtectedEntry[]
}

interface SideEffectInventory {
  readonly scan: { readonly uncoveredRepoFiles: readonly string[]; readonly sites: number }
}

interface ReportBaseline {
  readonly id: string
  readonly path: string
  readonly frozenSha256: string
  readonly status: string
}

interface BaselineRegistry {
  readonly reports: readonly ReportBaseline[]
}

const registry = JSON.parse(readFileSync(join(DATA, 'protected-artifacts.json'), 'utf8')) as ProtectedRegistry
const inventory = JSON.parse(readFileSync(join(DATA, 'side-effect-inventory.json'), 'utf8')) as SideEffectInventory
const baselines = JSON.parse(readFileSync(join(ROOT, 'docs', 'convergence', 'data', 'report-baselines.json'), 'utf8')) as BaselineRegistry

const sha256 = (path: string): string => createHash('sha256')
  .update(readFileSync(path, 'utf8').replace(/\r\n/gu, '\n'))
  .digest('hex')

/** Run a command and return its exit code, tolerating a non-zero status. */
function run(command: string, args: readonly string[]): number {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: 'ignore' })
    return 0
  } catch (error) {
    const status = (error as { status?: number }).status
    return status ?? -1
  }
}

describe('EF-C1 evidence isolation: the registry is honest', () => {
  it('every protected artifact matches its recorded HEAD hash', () => {
    expect(registry.counts.total).toBeGreaterThan(280)
    const bad: string[] = []
    for (const entry of registry.entries) {
      // Generated configuration may be deliberately ahead of HEAD during a
      // round (the docs manifest is regenerated after a doc edit). Evidence and
      // convenience copies may not.
      if (entry.category === 'generated-configuration') continue
      const full = join(ROOT, entry.path)
      if (!existsSync(full)) { bad.push(`${entry.path}: absent`); continue }
      const current = sha256(full)
      if (current !== entry.headSha256) bad.push(`${entry.path}: ${current} != ${entry.headSha256}`)
      if (current !== entry.worktreeSha256) bad.push(`${entry.path}: drift since the registry was generated`)
      if (!entry.worktreeMatchesHead) bad.push(`${entry.path}: recorded as drifted`)
    }
    expect(bad).toEqual([])
    expect(registry.counts.driftedFrozen).toBe(0)
  })

  it('the five minimum protected paths are all registered', () => {
    const paths = new Set(registry.entries.map(entry => entry.path))
    for (const path of [
      'docs/12_R1_EVALUATION_REPORT.md',
      'docs/MANIFEST.json',
      'cordis.patch.yml',
      'eval/r33/out/live-report.json',
      'eval/r33/out/offline-report.json',
    ]) {
      expect(paths.has(path), `${path} must be protected`).toBe(true)
    }
  })
})

describe('EF-C1 evidence isolation: verify modes write nothing', () => {
  it('generate-presets --check leaves every protected artifact unchanged', () => {
    const before = registry.entries.map(entry => [entry.path, sha256(join(ROOT, entry.path))] as const)
    const code = run(process.execPath, ['scripts/generate-presets.mjs', '--check'])
    // 0 = current, 2 = out of date. 1 would be a crash.
    expect([0, 2]).toContain(code)
    for (const [path, hash] of before) {
      expect(sha256(join(ROOT, path)), `${path} was written by --check`).toBe(hash)
    }
  })

  it('generate-maps --check leaves every protected artifact unchanged', () => {
    const before = registry.entries.map(entry => [entry.path, sha256(join(ROOT, entry.path))] as const)
    const code = run(process.execPath, ['scripts/generate-maps.cjs', '--check'])
    // 0 = current, 2 = not-verifiable (a worktree without the vendor tree).
    expect([0, 2]).toContain(code)
    for (const [path, hash] of before) {
      expect(sha256(join(ROOT, path)), `${path} was written by --check`).toBe(hash)
    }
  })

  it('the docs-manifest default leaves every protected artifact unchanged', () => {
    const before = registry.entries.map(entry => [entry.path, sha256(join(ROOT, entry.path))] as const)
    const code = run(process.execPath, ['scripts/generate-docs-manifest.mjs'])
    expect([0, 2]).toContain(code)
    for (const [path, hash] of before) {
      expect(sha256(join(ROOT, path)), `${path} was written by the compare mode`).toBe(hash)
    }
  })
})

describe('EF-C1 evidence isolation: the inventory is complete', () => {
  it('every repository-shaped write is classified', () => {
    expect(inventory.scan.sites).toBeGreaterThan(100)
    expect(inventory.scan.uncoveredRepoFiles).toEqual([])
  })

  it('every declared historical report still matches its frozen hash', () => {
    expect(baselines.reports.length).toBeGreaterThanOrEqual(4)
    for (const report of baselines.reports) {
      const full = join(ROOT, report.path)
      expect(existsSync(full), `${report.path} is declared but absent`).toBe(true)
      expect(sha256(full), `${report.path} changed without a baseline update`).toBe(report.frozenSha256)
      expect(['current', 'stale', 'superseded']).toContain(report.status)
    }
  })
})
