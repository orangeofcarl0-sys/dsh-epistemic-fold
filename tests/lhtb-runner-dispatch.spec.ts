/**
 * The LHTB runner must actually read the mode it is asked for.
 *
 * ## The defect this pins
 *
 * `scripts/run-lhtb.sh` never read `$1`. It always passed
 * `eval/lhtb/lhtb-ef-probe.yaml` — one task, one attempt,
 * `n_concurrent_trials: 1` — no matter what it was invoked as. So the Phase 7
 * handoff's own commands,
 *
 *     bash scripts/run-lhtb.sh sweep
 *     bash scripts/run-lhtb.sh oracle
 *
 * each ran a single-task probe while printing a normal-looking run. The oracle
 * gate invoked that way would have "passed" while proving nothing about the
 * environment, which is the failure mode the handoff itself warns about: an
 * invocation that measures something other than what it claims, and reports it
 * as success.
 *
 * It is the same shape as the `roots=0` finding — a value that could not mean
 * what it claimed, read as if it did — except here it is a value that could
 * never differ, so no amount of further reading would have found it.
 *
 * ## Why this test drives the REAL script
 *
 * Asserting on the script's text would pass against a runner that reads the mode
 * and then ignores it. The dispatch has to be exercised, so this builds a
 * hermetic LHTB fixture — a fake `harbor.exe` that prints the config it was
 * handed, a fake `python.exe` that performs the one credential read, and a
 * throwaway credential file — and runs the actual script against it. Nothing
 * here touches a real Harbor, a real benchmark checkout, or a real credential.
 *
 * The fixture's `harbor.exe` name is not arbitrary: the runner hardcodes the
 * Windows venv layout, and on Windows the exec bit is carried by the `.exe`
 * extension rather than by a mode, so the `[ -x "$HARBOR_EXE" ]` guard only
 * passes for that name.
 *
 * @module tests/lhtb-runner-dispatch
 */

import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
/**
 * The runner is invoked by ABSOLUTE path on purpose.
 *
 * That is what the Phase 7 handoff tells an operator to do, and on Windows it
 * used to fail before reaching any dispatch logic: the script sourced
 * `proxy-env.sh` through `${BASH_SOURCE[0]%/*}`, which cannot strip a backslash
 * path, so `bash 'C:\...\scripts\run-lhtb.sh' oracle` resolved it to
 * `...\run-lhtb.sh/proxy-env.sh` and died with "Not a directory". The
 * documented relative invocation never exercised it. Invoking this way keeps
 * that fixed.
 */
const RUNNER = join(ROOT, 'scripts', 'run-lhtb.sh')
/** Whether a usable `bash` exists. CI is Linux; this machine is Git Bash. */
function bashAvailable(): boolean {
  const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
  return probe.status === 0
}

const HAS_BASH = bashAvailable()

/**
 * The fake Harbor: print the argv, then the config it was pointed at.
 *
 * Echoing the config is what makes the assertion possible — the runner selects a
 * config by writing a `sed`-rewritten copy to a temp path, so the only honest
 * check is the content Harbor would actually have read.
 */
const FAKE_HARBOR = `#!/bin/sh
echo "FAKE_HARBOR argv: $*"
while [ $# -gt 0 ]; do
  if [ "$1" = "-c" ]; then shift; echo "FAKE_HARBOR config=$1"; cat "$1"; fi
  shift
done
`

/**
 * The fake interpreter, doing the one thing the runner asks of it.
 *
 * The runner shells out to the Harbor venv's Python solely to read
 * `OPENCODE_GO_API_KEY` out of the refs block. Reproducing that with `grep`/`sed`
 * keeps the fixture free of a Python dependency, and keeps the credential read
 * path — which the real script depends on — genuinely exercised. `$2` is the
 * credential path: the runner invokes it as `<python> - <credentials>`.
 */
const FAKE_PYTHON = `#!/bin/sh
grep -m1 "OPENCODE_GO_API_KEY:" "$2" | sed "s/.*OPENCODE_GO_API_KEY:[[:space:]]*//" | tr -d "[:space:]"
`

interface Fixture {
  readonly root: string
  readonly credentials: string
}

/** Build a throwaway LHTB checkout + credential store. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ef-lhtb-dispatch-'))
  const scripts = join(root, 'harbor', '.venv', 'Scripts')
  mkdirSync(scripts, { recursive: true })
  for (const [name, body] of [['harbor.exe', FAKE_HARBOR], ['python.exe', FAKE_PYTHON]] as const) {
    const path = join(scripts, name)
    writeFileSync(path, body, { encoding: 'utf8' })
    chmodSync(path, 0o755)
  }
  const credentials = join(root, 'creds.yaml')
  // A syntactically valid placeholder. The runner only checks that it is
  // non-empty and reports its LENGTH; no request is ever made with it.
  writeFileSync(credentials, 'refs:\n  OPENCODE_GO_API_KEY: fixture-placeholder-key\n', 'utf8')
  return { root, credentials }
}

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Invoke the real runner against a fixture. */
function run(f: Fixture, mode: string | undefined, env: Record<string, string> = {}): RunResult {
  const args = mode === undefined ? [RUNNER] : [RUNNER, mode]
  const result = spawnSync('bash', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LHTB_ROOT: f.root,
      DSH_CREDENTIALS: f.credentials,
      EF_LHTB_ARM: 'basic',
      // The runner now probes the live route with the bridge's own transport
      // before starting Harbor. That check is about THIS machine's network, not
      // about dispatch, so it is skipped here: a unit test must not depend on
      // the provider being reachable, and it must not spend a network round trip
      // per invocation. `tests/lhtb-parallelism.spec.ts` pins that the runner
      // runs the preflight and that it is skippable this way.
      EF_SKIP_ROUTE_CHECK: '1',
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Run `body` against a fresh fixture, removing it afterwards. */
function withFixture(body: (f: Fixture) => void): void {
  const f = fixture()
  try {
    body(f)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
}

describe.skipIf(!HAS_BASH)('the LHTB runner dispatches on its mode argument', () => {
  it('selects the config the mode names, not always the probe', () => {
    withFixture((f) => {
      const expected = new Map([
        ['probe', 'lhtb-ef-probe.yaml'],
        ['sweep', 'lhtb-ef-sweep.yaml'],
        ['oracle', 'lhtb-ef-oracle.yaml'],
      ])
      for (const [mode, config] of expected) {
        const result = run(f, mode)
        expect(result.status, `${mode} exited non-zero: ${result.stderr}`).toBe(0)
        // The job name carries the mode, and the config Harbor read must be the
        // one that mode names. Before the fix every row here said `probe`.
        expect(result.stdout, `${mode} did not select ${config}`).toContain(`config=${config}`)
        expect(result.stdout).toMatch(new RegExp(`job: lhtb-ef-\\S*-${mode}-basic`, 'u'))
      }
    })
  })

  it('rejects an unknown mode instead of degrading to a probe', () => {
    withFixture((f) => {
      const result = run(f, 'bogus')
      expect(result.status, 'a typo must not be a silent probe').toBe(1)
      expect(result.stderr).toMatch(/unknown mode: bogus/u)
      // And it must not have reached Harbor at all.
      expect(result.stdout).not.toContain('FAKE_HARBOR')
    })
  })

  it('falls back to EF_LHTB_MODE when no argument is given, and argv wins over it', () => {
    withFixture((f) => {
      // The sweep loop drives arms from the environment, so the env fallback has
      // to work without an argv.
      const fromEnv = run(f, undefined, { EF_LHTB_MODE: 'oracle' })
      expect(fromEnv.status).toBe(0)
      expect(fromEnv.stdout).toContain('config=lhtb-ef-oracle.yaml')

      // An explicit argument outranks the environment: a caller that says
      // `sweep` while the environment says `oracle` gets `sweep`.
      const argvWins = run(f, 'sweep', { EF_LHTB_MODE: 'oracle' })
      expect(argvWins.status).toBe(0)
      expect(argvWins.stdout).toContain('config=lhtb-ef-sweep.yaml')

      // And with neither, the documented default is the probe.
      const neither = run(f, undefined)
      expect(neither.status).toBe(0)
      expect(neither.stdout).toContain('config=lhtb-ef-probe.yaml')
    })
  })

  it('names a job per (mode, arm) so four sweep arms cannot collide', () => {
    withFixture((f) => {
      // Harbor keys its output on `job_name` and, finding one already present,
      // exits while still reporting the PREVIOUS run's reward. Four sweep arms
      // share a mode, so a mode-only suffix would make three of them read
      // another arm's numbers.
      const economy = run(f, 'sweep', { EF_LHTB_ARM: 'economy' })
      const quality = run(f, 'sweep', { EF_LHTB_ARM: 'quality' })
      const jobOf = (out: string): string => /job: (\S+)/u.exec(out)?.[1] ?? ''
      expect(jobOf(economy.stdout)).toContain('-sweep-economy')
      expect(jobOf(quality.stdout)).toContain('-sweep-quality')
      expect(jobOf(economy.stdout)).not.toBe(jobOf(quality.stdout))
    })
  })

  it('is syntactically valid', () => {
    // `bash -n` needs no fixture, and it is the check CI can run everywhere.
    expect(() => execFileSync('bash', ['-n', RUNNER], { stdio: 'pipe' })).not.toThrow()
  })
})
