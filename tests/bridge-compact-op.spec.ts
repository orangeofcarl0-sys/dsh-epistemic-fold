/**
 * Compression depth must be a number the driver ASKS for, and an honest one.
 *
 * ## Why the op exists
 *
 * `docs/62_MEMORY_PRESSURE_TASK_DESIGN.md` section 4: natural pressure cannot supply an
 * independent variable, because the fold count depends on the corpus, the threshold and the
 * provider, so it varies per cell and no curve can be drawn. The `compact` op turns depth into
 * something the driver requests.
 *
 * ## Why it reports `committed` rather than nothing
 *
 * `compactIfNeeded` legitimately DECLINES -- there may be no pressure, or no safe range. A driver
 * that counted its own calls as depth would record a depth the engine never reached, and every
 * downstream figure -- exposure, the retention curve, the matched-size comparison -- would then
 * be computed against a number describing the caller rather than the engine.
 *
 * The same reasoning appears on the Python side, where the method returns a bool so the caller
 * has to decide what to do about a decline rather than being able to ignore it.
 *
 * ## Why it routes through `foldIfNeeded`
 *
 * So it inherits the fold deadline, the failure containment, and the lineage capture rather than
 * duplicating them. A second fold path would be a second place for those to be wrong.
 *
 * @module tests/bridge-compact-op
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const HOST = readFileSync(join(ROOT, 'eval', 'tau2', 'bridge-host.ts'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'eval', 'bridge', 'ef_bridge_client.py'), 'utf8')

describe('the compact operation', () => {
  it('is dispatched by the host', () => {
    expect(HOST).toContain("op === 'compact'")
  })

  it('reports whether a fold actually committed', () => {
    expect(HOST).toMatch(/const committed = \(after\.leaves - before\.leaves\)/u)
    // The emit also carries a `measure` block now, so the assertion matches the CALL and the
    // field it must report rather than pinning the exact line -- which is what made this test
    // fail when that block was added.
    expect(HOST).toMatch(/emit\(\{ ok: true, committed, telemetry: await telemetry\(\),/u)
  })

  it('routes through foldIfNeeded, so it inherits the deadline and the lineage', () => {
    const at = HOST.indexOf("op === 'compact'")
    // The branch runs to the NEXT op, not to a fixed character count. A window measured in
    // characters broke the moment a comment was added above `foldIfNeeded` (1600 -> 4423),
    // and a test that fails on documentation is testing the wrong thing.
    const next = HOST.indexOf("} else if (op ===", at + 1)
    const branch = HOST.slice(at, next === -1 ? undefined : next)
    expect(branch).toContain('await foldIfNeeded()')
    // And it must NOT call compactIfNeeded directly, which would bypass both.
    expect(branch).not.toContain('compactIfNeeded(')
  })

  it('is exposed on the Python side as a bool, so a decline cannot be ignored', () => {
    expect(CLIENT).toContain('def compact(self) -> bool:')
    expect(CLIENT).toContain('return bool(response.get("committed"))')
    expect(CLIENT).toContain('{"op": "compact"}')
  })

  it('tells the caller to count commits rather than calls', () => {
    expect(CLIENT).toContain('the caller counts commits, not calls')
  })
})
