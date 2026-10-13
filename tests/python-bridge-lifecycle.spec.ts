/**
 * The bridge is a CHILD PROCESS, so its lifecycle needs its own tests.
 *
 * `tests/fixtures/python-bridge-lifecycle.py` drives four endings with short-lived children and
 * reports, for each, whether the ONE `Popen` handle it created was reaped. It never searches for
 * `node.exe`: a pass cannot be manufactured by killing an unrelated process, and a leftover is
 * attributed to the fixture that made it.
 *
 * ## The regression this pins
 *
 * The episode body used to call `close()` on its normal path only, so an exception raised inside
 * it left the bridge to exit on its own, if it did. `run()` now wraps that body in `try/finally`,
 * which is what makes `episodeRaises.reaped` true.
 *
 * ## Why the forced case is recorded, not asserted as a guarantee
 *
 * Killing the Python parent outright leaves no Python code to run. Measured here it did NOT orphan
 * the bridge -- the child's stdin closes and it exits -- but that is the pipe's behaviour, not a
 * promise this code can make, so it is reported separately from the paths Python controls.
 *
 * @module tests/python-bridge-lifecycle
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = process.env.EF_HARBOR_PY
  ?? 'D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe'
const DRIVER = join(ROOT, 'tests', 'fixtures', 'python-bridge-lifecycle.py')
const canRun = existsSync(PY)

function runDriver(): Record<string, Record<string, unknown>> {
  const out = execFileSync(PY, [DRIVER], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 })
  const line = out.trim().split(/\r?\n/u).filter(text => text.startsWith('{')).pop()
  if (line === undefined) throw new Error(`driver produced no JSON: ${out.slice(-400)}`)
  return JSON.parse(line) as Record<string, Record<string, unknown>>
}

describe.skipIf(!canRun)('bridge child-process lifecycle', () => {
  const result = canRun ? runDriver() : {}

  it('reaps the bridge on the documented close path, and close is idempotent', () => {
    expect(result['normalClose']!['reaped']).toBe(true)
    expect(result['normalClose']!['idempotentSecondClose']).toBe(true)
  })

  it('bounds the wait when the host never answers op:"close"', () => {
    expect(result['closeIgnored']!['reaped']).toBe(true)
    expect(result['closeIgnored']!['boundedUnder15s'], 'terminate/kill cannot park forever').toBe(true)
  })

  it('closes the bridge when the episode RAISES, without swallowing the exception', () => {
    // Both halves matter: a fix that reaped the child by swallowing the error would be worse
    // than the leak.
    expect(result['episodeRaises']!['exceptionPropagated']).toBe('injected mid-episode failure')
    expect(result['episodeRaises']!['reaped'], 'the try/finally in run()').toBe(true)
  })

  it('records forced parent termination separately, as the OS boundary it is', () => {
    const forced = result['forcedParentTermination']!
    expect(typeof forced['bridgePid']).toBe('number')
    // Deliberately not asserted as "must not survive": whatever the host does is the measurement.
    expect(typeof forced['survivedParentTermination']).toBe('boolean')
  })
})