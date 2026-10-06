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
 * The WSL memory cap on this host, from `~/.wslconfig`.
 *
 * ## Corrected from 24 to 8
 *
 * The first version of this spec asserted 24 GB, and that was wrong here.
 * `~/.wslconfig` says `memory=8GB`; its own comment records a deliberate
 * 2026-09-24 reduction from 12 GB to 8 GB on a 15.2 GB host; and `docker info`
 * reports `MemTotal` 8,326,361,088 bytes = **7.75 GiB**. All three verified.
 *
 * The error was load-bearing, which is why it is recorded rather than quietly
 * fixed: at 24 the assertion below (`declaredTwoGiB <= WSL_CAP_GB`, i.e.
 * `12 <= 24`) PASSED, and at the true 8 it FAILS. The false cap was what kept a
 * wrong assertion green — the same shape as the `roots` detector, where a number
 * that could not mean what it claimed was read as if it did.
 *
 * The assertion was also wrong in kind. It summed the tasks' DECLARED
 * `memory_mb` values and compared them to the cap — but a `memory_mb` is a cgroup
 * limit, not a reservation, which is the very point this file exists to make.
 * Docker does not preallocate it, so two cells declared at 8 GiB and 4 GiB do not
 * consume 12 GiB. The check now compares the MEASURED figures to the cap, which
 * is the comparison that decides whether parallelism fits.
 */
const WSL_CAP_GB = 8

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

  it('two measured cells fit inside the WSL cap with room for the build spikes', () => {
    // MEASURED, not declared. A `memory_mb` is a cgroup limit that Docker does
    // not preallocate, so summing the declared values would compare a ceiling
    // against the cap — the misreading this file exists to correct. The steady
    // state is what two concurrent cells actually hold.
    const twoCellsMiB = Object.values(MEASURED).reduce((sum, m) => sum + m.observedMiB, 0)
    expect(
      twoCellsMiB / 1024,
      `two cells held ${twoCellsMiB.toFixed(1)} MiB against a ${WSL_CAP_GB} GB cap`,
    ).toBeLessThan(WSL_CAP_GB)
    // And the observed use must leave room for the build/verifier spikes, which
    // is why the configs stay at 2 rather than pushing to what steady state
    // would allow. Half the cap is a conservative reading of "room".
    expect(twoCellsMiB / 1024).toBeLessThan(WSL_CAP_GB / 2)
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

  it('no config repeats the 24 GB cap that this spec exists to correct', () => {
    // The correction above reached the spec and the runner but NOT the two
    // configs the Phase 7 sweep actually invokes, so both still told the reader
    // the cap was 24 GB — while asserting a parallelism claim that only holds at
    // 8. The spec's own measured figures are the source of truth, and the prose
    // in every config must agree with them.
    //
    // This is the same failure shape the file documents: a number that could not
    // mean what it claimed, read as if it did. Nothing read the yaml prose, so
    // nothing could fail.
    for (const config of ['eval/lhtb/lhtb-ef-probe.yaml', 'eval/lhtb/lhtb-ef-sweep.yaml', 'eval/lhtb/lhtb-ef-oracle.yaml']) {
      const text = read(config)
      expect(
        text,
        `${config} claims a 24 GB cap; the measured cap is ${WSL_CAP_GB} GB`,
      ).not.toMatch(/cap is 24 GB|cap had already been raised to 24/u)
      // And a config that discusses the cap must state the measured value.
      if (/WSL (VM is |)cap|wslconfig/u.test(text)) {
        expect(text, `${config} must state the measured cap`).toMatch(
          new RegExp(`cap IS ${WSL_CAP_GB} GB|cap is ${WSL_CAP_GB} GB|memory=${WSL_CAP_GB}GB`, 'u'),
        )
      }
    }
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
})
