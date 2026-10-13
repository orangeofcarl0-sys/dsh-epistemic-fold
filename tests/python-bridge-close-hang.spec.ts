/**
 * Case B: `close()` against a child that is alive, keeps stdout open, and never answers.
 *
 * Run in a SEPARATE worker with a hard watchdog: if the client waits on the close handshake, the
 * elapsed time is the finding, and the watchdog is what stops the suite from hanging instead of
 * reporting it.
 *
 * @module tests/python-bridge-close-hang
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = process.env.EF_HARBOR_PY
  ?? 'D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe'
const DRIVER = join(ROOT, 'tests', 'fixtures', 'python-bridge-close-hang.py')
const canRun = existsSync(PY)

describe.skipIf(!canRun)('close() against a silent but live child', () => {
  it('returns within a bounded time instead of waiting out the read timeout', () => {
    // The watchdog. If `close()` waits on the handshake this throws ETIMEDOUT, which is the
    // reproduction rather than an inconclusive hang.
    const out = execFileSync(PY, [DRIVER], { encoding: 'utf8', cwd: ROOT, timeout: 60_000 })
    const line = out.trim().split(/\r?\n/u).filter(text => text.startsWith('{')).pop()!
    const result = JSON.parse(line) as Record<string, unknown>
    expect(result['readTimeoutSec'], 'the production timeout is not shortened').toBe(1200)
    expect(result['closeElapsedSec'] as number).toBeLessThan(15)
    expect(result['boundedUnder15s']).toBe(true)
    expect(result['reaped'], 'the child is still terminated').toBe(true)
  }, 90_000)
})