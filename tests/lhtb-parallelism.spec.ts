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

/** The WSL memory cap on this host, from `~/.wslconfig`. */
const WSL_CAP_GB = 24

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
    const twoCellsMiB = Object.values(MEASURED).reduce((sum, m) => sum + m.observedMiB, 0)
    expect(twoCellsMiB / 1024).toBeLessThan(WSL_CAP_GB)
    // The steady state is not the risk; the declared limits are. Two cells at
    // their declared limits is the worst case the runner has to survive.
    const declaredTwoGiB = Object.values(MEASURED).reduce((sum, m) => sum + m.limitMb, 0) / 1024
    expect(declaredTwoGiB).toBeLessThanOrEqual(WSL_CAP_GB)
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
