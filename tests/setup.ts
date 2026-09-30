/**
 * Suite teardown: reclaim this run's scratch directories.
 *
 * `eval/tmp.ts` registers every directory it creates and can remove them all,
 * but registration is per-process and vitest runs each test file in its own
 * forked process. So this file runs inside each worker and removes that worker's
 * own directories on the way out.
 *
 * Without it, a full run leaves a few hundred empty directories behind — small,
 * and contained in the one managed subtree, but still unbounded growth across
 * runs. With it, a run ends where it started.
 *
 * The sweep in `scripts/sweep-temp.mjs` remains the backstop for a crashed or
 * killed run, where no teardown can execute.
 *
 * @module tests/setup
 */

import { afterAll } from 'vitest'
import { cleanupTemps, registeredTemps } from '../eval/tmp.ts'

afterAll(async () => {
  // Report only when there is something to report: a silent suite should stay
  // silent, and a suite that leaked should say so.
  const pending = registeredTemps().length
  const removed = await cleanupTemps()
  if (removed > 0 && process.env.EF_TEMP_VERBOSE === '1') {
    console.log(`scratch: reclaimed ${removed} director${removed === 1 ? 'y' : 'ies'} (${pending} pending)`)
  }
})
