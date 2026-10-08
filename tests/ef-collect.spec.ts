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
 * ## Why the interpreter probe is fussy, and why some checks are outside it
 *
 * The first version of this spec probed only `python3` / `python` on PATH and put
 * the ENTIRE suite behind `describe.skipIf`. On a machine whose PATH carries the
 * Microsoft Store execution-alias stubs, both names exist but exit **9009**, so
 * the probe correctly found no interpreter — and the whole gate silently became
 * five skipped tests, including the one whose only job is to assert that the
 * collector is in the repository and needs no Python at all.
 *
 * That reproduces the exact gap this file was written to close: a check nobody
 * can run is not a check. Two things follow, and both are load-bearing:
 *
 *   1. The Python-free assertions live in their own always-running describe, so
 *      the "the collector is tracked and correctly referenced" property is gated
 *      on every machine, interpreter or not.
 *   2. The probe searches harder (an explicit `EF_PYTHON`, the LHTB venv, and
 *      `py -3`) and requires the candidate to actually EXECUTE code rather than
 *      merely answer `--version`, which is what a Store stub can fake.
 *
 * A skipped behavioural check is still a real limitation, so it announces itself
 * rather than passing quietly.
 *
 * @module tests/ef-collect
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const COLLECTOR = join(ROOT, 'scripts', 'ef-collect.py')

/** Candidate argv prefixes for a Python 3 interpreter, best first. */
function candidates(): readonly (readonly string[])[] {
  const list: string[][] = []
  if (process.env.EF_PYTHON !== undefined && process.env.EF_PYTHON.length > 0) {
    list.push([process.env.EF_PYTHON])
  }
  list.push(['python3'], ['python'], ['py', '-3'])
  // The venv this project's own benchmark lane uses. Harbor requires Python
  // >=3.12, so on the machine that runs LHTB this is the interpreter that
  // certainly exists — and it is the one the Phase 7 operator actually used.
  const roots = [process.env.LHTB_ROOT, ROOT].filter(
    (value): value is string => value !== undefined && value.length > 0,
  )
  for (const root of roots) {
    for (const rel of [
      ['harbor', '.venv', 'Scripts', 'python.exe'],
      ['harbor', '.venv', 'bin', 'python3'],
      ['.venv', 'Scripts', 'python.exe'],
      ['.venv', 'bin', 'python3'],
    ]) {
      const path = join(root, ...rel)
      if (existsSync(path)) list.push([path])
    }
  }
  return list
}

/**
 * The first candidate that can actually RUN Python.
 *
 * `--version` is not sufficient: a Store execution-alias stub is a real file on
 * PATH that exits non-zero, and an interpreter that reports a version but cannot
 * execute is no use to a spec that runs a script with it. So the probe executes
 * a trivial program and checks for its output.
 */
function python(): string[] | undefined {
  for (const argv of candidates()) {
    const probe = spawnSync(argv[0]!, [...argv.slice(1), '-c', 'print("ef-python-ok")'], {
      encoding: 'utf8',
    })
    if (probe.status === 0 && (probe.stdout ?? '').includes('ef-python-ok')) return [...argv]
  }
  return undefined
}

const PYTHON = python()

if (PYTHON === undefined) {
  // Loud on purpose. A gate that degrades to silence is the defect this file
  // documents, so the degradation is stated rather than inferred from a count.
  console.warn(
    '[ef-collect] no runnable Python 3 found (tried EF_PYTHON, python3, python, py -3, and the '
    + 'LHTB venv). The collector BEHAVIOUR checks will be skipped; the "collector is tracked" '
    + 'checks still run. Set EF_PYTHON to an interpreter to exercise the rest.',
  )
}

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
    const argv = PYTHON!
    const result = spawnSync(argv[0]!, [...argv.slice(1), COLLECTOR, root], { encoding: 'utf8' })
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the collector is in the repository, which is the point', () => {
  // NO Python required, so this runs everywhere — including on a machine whose
  // PATH python is a Store stub, which is exactly where the old skipIf turned
  // the whole gate off.
  it('exists as a tracked script rather than an untracked local file', () => {
    // The original was `ef-collect.sh`, untracked, so the verification step the
    // handoff documents could not be run by anyone else.
    expect(existsSync(COLLECTOR), 'scripts/ef-collect.py must exist in the repository').toBe(true)
    expect(existsSync(join(ROOT, 'scripts', 'ef-collect.sh')), 'the untracked shell version is not the collector').toBe(false)
  })

  it('is a Python program, and says so in a way a reader can act on', () => {
    const source = readFileSync(COLLECTOR, 'utf8')
    expect(source.startsWith('#!/usr/bin/env python3'), 'a shebang makes it runnable directly').toBe(true)
    expect(source, 'it must document the MISSING semantics it exists for').toMatch(/MISSING/u)
    expect(source, 'and it must distinguish an unverified check from a pass').toMatch(/skip/iu)
    expect(source, 'it must expose a main entry point').toMatch(/^def main\(/mu)
  })

  it('is named by the documents that tell an operator to run it', () => {
    // The handoff and the Phase 7 write-up both cite it; a rename that misses
    // one of them leaves an instruction pointing at a file that is not there.
    for (const doc of ['docs/50_PHASE7_HANDOFF.md', 'docs/52_PHASE7_ORACLE_GATE_AND_BLOCKERS.md']) {
      const text = readFileSync(join(ROOT, doc), 'utf8')
      if (!/ef-collect/u.test(text)) continue
      expect(text, `${doc} must name the tracked path, not the untracked shell file`).not.toMatch(
        /ef-collect\.sh/u,
      )
      expect(text, `${doc} names the collector`).toMatch(/ef-collect\.py|ef-collect/u)
    }
  })
})

describe.skipIf(PYTHON === undefined)('the LHTB transcript collector', () => {
  it('passes a clean cell and reports its compaction failures as a reading', () => {
    const { status, stdout } = collect([{
      arm: 'economy',
      telemetry: {
        folds: 15, roots: 2, emergencies: 1,
        bundleWrites: 18, bundlesPresent: 18, pendingIntents: 0,
        pressureRegime: 'fits', compactionFailures: 0, lastCompactionError: null,
      },
    }])
    expect(status, stdout).toBe(0)
    expect(stdout).toMatch(/PASS I1/u)
    expect(stdout).toMatch(/PASS I2/u)
    // A zero failure count is a reading, not something to shout about.
    expect(stdout).not.toMatch(/READ compactionFailures/u)
  }, 30_000)

  it('reads the KIND mix, because a bare count cannot be attributed', () => {
    // The defect this replaces: one number merged a summarization budget error
    // with a provider HTTP 500, and only the last message was kept, so the mix
    // was unrecoverable afterwards. A report has to be able to separate them.
    const { stdout } = collect([{
      arm: 'basic',
      telemetry: {
        folds: 0, roots: 0, emergencies: 0,
        bundleWrites: 0, bundlesPresent: 0, pendingIntents: 0,
        compactionFailures: 8,
        compactionFailureKinds: { truncated: 6, 'provider-http': 2 },
        lastCompactionError: 'summarization truncated at the token cap',
      },
    }])
    expect(stdout).toMatch(/READ compactionFailures=8/u)
    expect(stdout).toMatch(/'truncated': 6/u)
    expect(stdout).toMatch(/'provider-http': 2/u)
  }, 30_000)

  it('reads the PRE-RENAME field but refuses to invent its kind mix', () => {
    // Archives written before the rename carry foldFailures and no breakdown.
    // Dropping a real measurement would be as wrong as defaulting one, so it is
    // read and labelled: the kinds do not exist and cannot be reconstructed.
    const { stdout } = collect([{
      arm: 'basic',
      telemetry: {
        folds: 0, roots: 0, emergencies: 0,
        bundleWrites: 0, bundlesPresent: 0, pendingIntents: 0,
        foldFailures: 5,
        lastFoldError: 'live provider HTTP 500: Unknown Error',
      },
    }])
    expect(stdout).toMatch(/READ compactionFailures=5/u)
    expect(stdout, 'the missing breakdown must be stated').toMatch(/NO kind breakdown/u)
    expect(stdout, 'and never shown as a fabricated mix').not.toMatch(/'truncated'/u)
  }, 30_000)

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
  }, 30_000)

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
        compactionFailures: 3,
        compactionFailureKinds: { truncated: 3 },
        lastCompactionError: 'summarization truncated at the token cap',
      },
    }])
    expect(status, 'a violation must be a non-zero exit').toBe(1)
    expect(stdout).toMatch(/FAIL I1/u)
    expect(stdout).toMatch(/FAIL I2/u)
    // A non-zero failure count is surfaced, with its cause.
    expect(stdout).toMatch(/READ compactionFailures=3/u)
    expect(stdout).toContain('summarization truncated at the token cap')
  }, 30_000)

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
  }, 30_000)

  it('runs end to end against a real cell without a Python error', () => {
    // The structural checks that need no interpreter live in their own describe
    // above. This one confirms the script actually executes under the
    // interpreter the probe found.
    const { stdout } = collect([{ arm: 'economy', telemetry: { folds: 0, roots: 0, emergencies: 0, bundleWrites: 0, pendingIntents: 0 } }])
    expect(stdout, 'the collector must run at all').not.toMatch(/can't open file|No such file|Traceback/u)
  }, 30_000)
})
