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
})
