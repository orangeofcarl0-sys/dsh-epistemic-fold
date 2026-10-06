/**
 * The LongWork lane's parallelism claim must be measured, not asserted.
 *
 * ## The defect this pins
 *
 * `scripts/run-lhtb.sh` and `eval/lhtb/lhtb-ef-probe.yaml` carried the same
 * sentence for the whole RC10 phase:
 *
 *     "Every LHTB task requests 4-8 GB of RAM and this host's WSL VM is capped at
 *      8 GB, so at most one trial runs at a time."
 *
 * Both halves were wrong, and the conclusion drawn from them - that the LongWork
 * lane could only ever be run one cell at a time, forever - was wrong for a
 * reason no amount of further reading would have found:
 *
 *   - the WSL cap had already been raised to 24 GB in `~/.wslconfig`;
 *   - `memory_mb` in a task.toml is the CONTAINER LIMIT, not a reservation.
 *     Docker does not preallocate a cgroup limit.
 *
 * Measured with both discriminators running: vector-db held 192 MiB of its 8 GiB
 * and unknown-config 16 MiB of its 4 GiB. Two cells fit ~200x over.
 *
 * ## What is asserted
 *
 * The measured figures and the WSL cap are recorded here as data. If a future
 * revision of the runner claims serial again, or the machine's cap changes, this
 * fails rather than the claim quietly rotting. The numbers are a measurement
 * recorded once; they are NOT re-measured per test run, because that would need
 * Docker and hours of wall clock.
 *
 * @module tests/lhtb-parallelism
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

/**
 * Measured on this host with both discriminators running under Harbor, via
 * `docker stats --no-stream`. Peak observed across the agent phase; the build
 * and verifier phases are the ones that spike, which is why the configs leave
 * `n_concurrent_trials` at 2 rather than at the number these would justify.
 */
const MEASURED = {
  'vector-db-iterative-build': { limitMb: 8192, observedMiB: 192.8 },
  'unknown-config-semantics': { limitMb: 4096, observedMiB: 15.7 },
} as const

/**
 * The memory the container runtime can actually hand out, ASKED of the machine.
 *
 * ## Why this is read and never recorded
 *
 * Two revisions hardcoded it — first 24, then 8 — and each was a measurement of
 * one machine committed as a fact about every machine. The 8 was the worse of the
 * two, because it was wrong on the host that ran Phase 7: that host's
 * `~/.wslconfig` says `memory=24GB`, it has 31.2 GB of RAM (not the 15.2 GB the
 * comment described), and `docker info` reports `MemTotal` 25,197,441,024 bytes =
 * **23.47 GiB**. The "verified three ways" note described a different computer.
 *
 * It was load-bearing in the wrong direction: the gate at the bottom of this file
 * then REJECTED a truthful config for saying 24, so correcting the prose to match
 * the machine turned the suite red. This file's own header had the right number
 * (`raised to 24 GB`) while the constant below it held 8 — the file disagreed
 * with itself and nothing could notice, because nothing read the machine.
 *
 * `docker info` is the authority: it is the memory the runtime will actually
 * hand a container, which is what decides whether two cells fit. `~/.wslconfig`
 * is the fallback for a host where Docker is not up. A machine that cannot be
 * asked returns `undefined`, and the caller SKIPS rather than passing — an
 * unmeasured cap is not a passing cap, which is the `ef-collect` rule and the
 * `roots=0` mistake in one sentence.
 */
function runtimeCapGb(): number | undefined {
  const info = spawnSync('docker', ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8' })
  if (info.status === 0) {
    const bytes = Number((info.stdout ?? '').trim())
    if (Number.isFinite(bytes) && bytes > 0) return bytes / 1024 ** 3
  }
  try {
    const config = readFileSync(join(homedir(), '.wslconfig'), 'utf8')
    const declared = /^\s*memory\s*=\s*(\d+)\s*GB\s*$/mu.exec(config)
    if (declared) return Number(declared[1])
  } catch {
    // No ~/.wslconfig on this host; falls through to "unmeasurable".
  }
  return undefined
}

const CAP_GB = runtimeCapGb()

describe('the LongWork lane can run in parallel, and the reason is on the record', () => {
  it('observed container use is a small fraction of the declared limit', () => {
    for (const [task, m] of Object.entries(MEASURED)) {
      // limitMb is MB (1024-based); observedMiB is MiB (also 1024-based), so
      // the ratio is observed/limit directly. Dividing the limit by 1024 first
      // would compare MiB against GiB.
      const ratio = m.observedMiB / m.limitMb
      expect(
        ratio,
        `${task} held ${m.observedMiB} MiB against a ${m.limitMb} MB limit; if this is no longer a small fraction, the parallelism claim needs re-measuring`,
      ).toBeLessThan(0.1)
    }
  })

  // Skipped, not passed, when the host cannot be asked. CI has no Docker, and a
  // hardcoded default is exactly the defect this replaced — an unmeasured cap
  // read as a passing one.
  it.skipIf(CAP_GB === undefined)('two measured cells fit inside THIS host\'s cap', () => {
    // MEASURED, not declared. A `memory_mb` is a cgroup limit that Docker does
    // not preallocate, so summing the declared values would compare a ceiling
    // against the cap — the misreading this file exists to correct. The steady
    // state is what two concurrent cells actually hold.
    //
    // The cap is read from the machine, so this bounds the claim against the host
    // instead of asserting a number that ships with the repository. It is a sanity
    // bound, not the load-bearing measurement: the test above — observed use as a
    // fraction of the DECLARED limit — is the host-independent one, and it is what
    // actually carries the parallelism claim.
    const cap = CAP_GB as number
    const twoCellsMiB = Object.values(MEASURED).reduce((sum, m) => sum + m.observedMiB, 0)
    expect(
      twoCellsMiB / 1024,
      `two cells held ${twoCellsMiB.toFixed(1)} MiB against this host's ${cap.toFixed(2)} GiB cap`,
    ).toBeLessThan(cap)
    // And the observed use must leave room for the build/verifier spikes, which
    // is why the configs stay at 2 rather than pushing to what steady state
    // would allow. Half the cap is a conservative reading of "room".
    expect(twoCellsMiB / 1024).toBeLessThan(cap / 2)
  })

  it('the runner no longer claims the lane is serial', () => {
    const script = read('scripts/run-lhtb.sh')
    expect(script).not.toMatch(/at most one trial runs at a time/u)
    expect(script, 'the corrected reasoning should be recorded where the old claim was').toMatch(
      /LIMIT, not a reservation|memory_mb` is the container/u,
    )
    expect(script).toMatch(/n_concurrent_trials/u)
  })

  it('every LHTB config that claims concurrency declares it explicitly', () => {
    for (const config of ['eval/lhtb/lhtb-ef-probe.yaml', 'eval/lhtb/lhtb-ef-sweep.yaml', 'eval/lhtb/lhtb-ef-oracle.yaml']) {
      const text = read(config)
      const declared = /^n_concurrent_trials:\s*(\d+)$/mu.exec(text)
      expect(declared, `${config} does not declare n_concurrent_trials`).not.toBeNull()
      expect(Number(declared![1])).toBeGreaterThan(0)
      // The serial probe is the one config allowed to be serial, and it says so.
      if (Number(declared![1]) === 1) {
        expect(text, 'a serial config must justify it').toMatch(/[Ss]erial: see the memory note/u)
      }
    }
  })

  it('no committed file asserts a host-specific memory cap', () => {
    // A committed file ships to other machines, so a numeric cap in one is a
    // measurement of the machine it was written on, stated as a fact about every
    // machine — the same shape as a baked-in `LHTB_ROOT` path, and for the same
    // reason the runner deliberately has no default for that.
    //
    // Two revisions did exactly this. The second was load-bearing: the gate that
    // used to live here REQUIRED the configs to say `cap IS 8 GB` and REJECTED
    // `cap is 24 GB`, so on the host that ran Phase 7 — whose `~/.wslconfig` says
    // `memory=24GB` — correcting the prose to match the machine turned the suite
    // red. A gate cannot answer a host question from a committed constant, and one
    // that tries will enforce whichever host it was written on.
    //
    // So the rule is the honest one: no committed prose states a cap number at
    // all. The configs state what is true of every host — a `memory_mb` is a
    // limit and not a reservation, plus the measured cells — and point at the
    // check for the part that is a property of the host.
    for (const file of [
      'eval/lhtb/lhtb-ef-probe.yaml',
      'eval/lhtb/lhtb-ef-sweep.yaml',
      'eval/lhtb/lhtb-ef-oracle.yaml',
      // The runner carried the same sentence, and it ships in the package too.
      'scripts/run-lhtb.sh',
    ]) {
      const text = read(file)
      expect(
        text,
        `${file} asserts a host-specific cap; the cap belongs to the host, not the file`,
      ).not.toMatch(/(?:WSL\s+)?cap\s+(?:IS|is)\s*\d+\s*GB|memory\s*=\s*\d+\s*GB/u)
    }

    // And this spec must not go back to holding one either: reading the machine is
    // the property, a literal is the defect.
    const self = read('tests/lhtb-parallelism.spec.ts')
    expect(self, 'the cap must be ASKED of the machine').toContain('docker info')
    expect(self, 'a literal cap is the defect this replaced').not.toMatch(
      /(?:const|let)\s+WSL_CAP_GB\s*=\s*\d+/u,
    )
  })

  it('the configs quote the measured memory, not a third number', () => {
    // Three different figures for one measurement were in circulation: 108 MiB
    // (oracle, sweep), 193 MiB (probe, runner, handoff) and "~125 MiB combined".
    // Only one can be the measurement the spec records, and a report that quotes
    // any other is quoting a number nothing measured.
    const vectorDb = MEASURED['vector-db-iterative-build'].observedMiB
    const unknownConfig = MEASURED['unknown-config-semantics'].observedMiB
    for (const config of ['eval/lhtb/lhtb-ef-sweep.yaml', 'eval/lhtb/lhtb-ef-oracle.yaml']) {
      const text = read(config)
      expect(text, `${config} still quotes the superseded 108 MiB figure`).not.toMatch(/108 MiB/u)
      expect(text, `${config} must quote the measured vector-db figure`).toContain('193 MiB')
    }
    // The combined figure, wherever it appears, must be the sum.
    const sweep = read('eval/lhtb/lhtb-ef-sweep.yaml')
    const combined = Math.round(vectorDb + unknownConfig)
    if (/combined/u.test(sweep)) {
      expect(sweep, `the combined figure must be the sum (${combined} MiB)`).toContain(`${combined} MiB`)
    }
  })

  it('the route precondition uses the bridge transport, not curl', () => {
    // `curl` falls back across the address set and Node's fetch does not, so a
    // curl-based precondition passes on hosts where every model call fails. The
    // handoff told the operator to use curl, and that cost a full probe.
    const handoff = read('docs/50_PHASE7_HANDOFF.md')
    expect(handoff, 'the precondition must name the bridge-transport check').toContain(
      'node scripts/check-route.mjs',
    )
    expect(
      handoff,
      'the curl-based precondition is the defect and must not be recommended',
    ).not.toMatch(/`curl -s -o \/dev\/null -w '%\{http_code\}'/u)

    // The check must use Node's fetch against the adapter's own endpoint shape,
    // or it measures a different transport than the one that will fail.
    const check = read('scripts/check-route.mjs')
    expect(check, 'the check must use the bridge transport').toContain('await fetch(')
    expect(check, 'it must hit the endpoint the adapter posts to').toContain('/chat/completions')
    // And it must classify the failure, since "fetch failed" names no cause.
    expect(check).toMatch(/ECONNREFUSED|classify/u)

    // The runner must invoke it before Harbor, so a transport fault costs
    // seconds rather than an episode budget.
    const runner = read('scripts/run-lhtb.sh')
    expect(runner, 'the runner must run the preflight').toContain('check-route.mjs')
    expect(runner, 'and it must be skippable for a deliberate down-route run').toContain(
      'EF_SKIP_ROUTE_CHECK',
    )
  })

  it('the proxy label describes the TRANSPORT, not the environment', () => {
    // The label used to be `NODE_USE_ENV_PROXY === '1' || HTTPS_PROXY !== undefined`,
    // so a bare `HTTPS_PROXY` printed "proxy: enabled" while Node ignored it and
    // connected directly — measured: the request reached the origin (HTTP 200)
    // with the proxy pointed at a dead port. That is an ironic failure for a tool
    // whose purpose is to stop a check describing the environment instead of the
    // transport, which is precisely what `curl` did.
    //
    // Node honours the proxy environment only with NODE_USE_ENV_PROXY=1, so the
    // label has to say which of the three states holds. Run for real, because the
    // whole point is that the environment does not tell you.
    const run = (env: Record<string, string>): string => {
      const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-route.mjs'), '--attempts', '1'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          // A dead port, so "in effect" is observable as a failure.
          HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
          ALL_PROXY: '', all_proxy: '', NODE_USE_ENV_PROXY: '',
          EF_LIVE_BASE_URL: 'https://127.0.0.1:1/v1',
          ...env,
        },
      })
      return `${result.stdout}${result.stderr}`
    }

    // No proxy configured: reported as direct, not as "enabled".
    expect(run({}), 'no proxy variables means direct').toMatch(/proxy: not in effect/u)

    // The trap: a proxy IS configured but Node will ignore it. This must NOT
    // read as enabled, and it must be called out before the generic advice.
    const trap = run({ HTTPS_PROXY: 'http://127.0.0.1:9' })
    expect(trap, 'a set-but-ignored proxy must not read as enabled').toMatch(/proxy: NOT in effect/u)
    expect(trap).toMatch(/NODE_USE_ENV_PROXY=1/u)
    expect(trap, 'the trap is the most likely cause and must be named').toMatch(/NOTE:/u)

    // Genuinely in effect: the flag is set, so Node routes through it.
    const live = run({ HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1' })
    expect(live, 'with the flag set the proxy is really used').toMatch(/proxy: in effect/u)
    expect(live, 'and a dead proxy then fails, which is the observable difference').toMatch(/0\/1 reached/u)
  })
})
