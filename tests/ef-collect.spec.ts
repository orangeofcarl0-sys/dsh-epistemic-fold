/**
 * The transcript collector must not read a MISSING field as a passing zero.
 *
 * ## The defect this exists for
 *
 * The Phase 7 write-up cited a collector (`ef-collect.sh`, untracked) as the tool
 * that checks the LHTB invariants — so the check the handoff tells the next
 * operator to run was not in the repository at all. An invariant that can only be
 * verified by a script nobody can read is not verified.
 *
 * It is now `scripts/ef-collect.py`, and this pins the one property that makes it
 * worth having: the pre-RC23 archives carry no `emergencies`, `bundleWrites`,
 * `bundlesPresent`, `pendingIntents`, `pressureRegime` or `foldFailures` at all.
 * Reading a missing field as `0` would make every invariant pass vacuously, which
 * is the `roots=0` mistake again — a number that could not mean what it claimed,
 * read as if it did.
 *
 * So three behaviours are pinned, against three synthetic transcripts: a clean
 * cell passes, a pre-RC23 cell SKIPS rather than passes, and a violating cell
 * fails with a non-zero exit.
 *
 * @module tests/ef-collect
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const COLLECTOR = join(ROOT, 'scripts', 'ef-collect.py')

/** Whether a usable Python 3 exists. */
function python(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return undefined
}

const PYTHON = python()

interface Cell {
  readonly arm: string
  readonly telemetry: Record<string, unknown>
}

/** Write one synthetic cell into a temp tree and run the collector over it. */
function collect(cells: readonly Cell[]): { status: number | null; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), 'ef-collect-'))
  try {
    cells.forEach((c, index) => {
      const dir = join(root, `cell-${index}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ef-transcript.json'), JSON.stringify({
        schema: 'ef-lhtb-transcript/1',
        provenance: { revision: 'deadbee' },
        arm: c.arm,
        telemetry: c.telemetry,
      }), 'utf8')
    })
    const result = spawnSync(PYTHON!, [COLLECTOR, root], { encoding: 'utf8' })
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(PYTHON === undefined)('the LHTB transcript collector', () => {
  it('passes a clean cell and reports its fold failures as a reading', () => {
    const { status, stdout } = collect([{
      arm: 'economy',
      telemetry: {
        folds: 15, roots: 2, emergencies: 1,
        bundleWrites: 18, bundlesPresent: 18, pendingIntents: 0,
        pressureRegime: 'fits', foldFailures: 0, lastFoldError: null,
      },
    }])
    expect(status, stdout).toBe(0)
    expect(stdout).toMatch(/PASS I1/u)
    expect(stdout).toMatch(/PASS I2/u)
    // A zero fold-failure count is a reading, not something to shout about.
    expect(stdout).not.toMatch(/READ foldFailures/u)
  })

  it('SKIPS rather than passes when a field is absent — the roots=0 mistake', () => {
    // Exactly the shape of a pre-RC23 archive: folds and roots present, nothing
    // else. Reading `bundleWrites` as 0 here would pass I1 vacuously.
    const { stdout } = collect([{ arm: 'basic', telemetry: { folds: 0, roots: 0 } }])
    expect(stdout, 'a missing counter must never be a passing zero').toMatch(/SKIP I1/u)
    expect(stdout).toMatch(/SKIP I2/u)
    expect(stdout).not.toMatch(/PASS I1/u)
    expect(stdout, 'unverified must be counted, not silently dropped').toMatch(
      /unverified check\(s\)/u,
    )
  })

  it('fails a cell that replaced the surface with no archive, and one that leaked', () => {
    const { status, stdout } = collect([{
      arm: 'economy',
      telemetry: {
        folds: 10, roots: 0, emergencies: 0,
        // Fewer bundles than folds: a surface replacement with no archive.
        bundleWrites: 7, bundlesPresent: 7,
        // And a producer with no consumer.
        pendingIntents: 2,
        pressureRegime: 'open-bound',
        foldFailures: 3,
        lastFoldError: 'summarization truncated at the token cap',
      },
    }])
    expect(status, 'a violation must be a non-zero exit').toBe(1)
    expect(stdout).toMatch(/FAIL I1/u)
    expect(stdout).toMatch(/FAIL I2/u)
    // A non-zero fold-failure count is surfaced, with its cause.
    expect(stdout).toMatch(/READ foldFailures=3/u)
    expect(stdout).toContain('summarization truncated at the token cap')
  })

  it('holds a basic arm to zero bundles, since real Basic has no bundle store', () => {
    const { status, stdout } = collect([{
      arm: 'basic',
      telemetry: {
        folds: 0, roots: 0, emergencies: 0,
        // A non-zero count here is impossible for real Basic — the exact defect
        // that made every pre-RC23 "basic" row describe EF-legacy.
        bundleWrites: 4, bundlesPresent: 4, pendingIntents: 0,
      },
    }])
    expect(status).toBe(1)
    expect(stdout).toMatch(/FAIL I3/u)
  })

  it('is present in the repository, which is the point', () => {
    // The original was untracked, so the handoff's own verification step could
    // not be run by anyone else. This asserts the script exists and is a Python
    // file the collector's own docstring describes.
    const { stdout } = collect([{ arm: 'economy', telemetry: { folds: 0, roots: 0, emergencies: 0, bundleWrites: 0, pendingIntents: 0 } }])
    expect(stdout, 'the collector must run at all').not.toMatch(/can't open file|No such file/u)
  })
})
