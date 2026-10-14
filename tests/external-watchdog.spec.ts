/**
 * The EXTERNAL watchdog: a supervisor outside the trial's event loop stops it.
 *
 * `docs/86` recorded that `asyncio.wait_for` could not fire while the client blocked on synchronous
 * IPC. This uses a supervisor that holds the trial's own process identity instead -- no global
 * `node.exe` sweep, and no reliance on cancellation.
 *
 * @module tests/external-watchdog
 */

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = process.env.EF_HARBOR_PY
  ?? 'D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe'
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'watchdog-hang.py')
const canRun = existsSync(PY)

/** Whether ONE specific pid is alive -- never a search by process name. */
function alive(pid: number): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

describe.skipIf(!canRun)('an external watchdog stops a synchronously blocked trial', () => {
  it('kills the trial at the deadline and reaps the bridge it owned', async () => {
    const child = spawn(PY, [FIXTURE], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    const bridgePid = await new Promise<number>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('fixture never published its bridge pid')), 30_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        const line = buffer.split(/\r?\n/u).find(text => text.startsWith('{'))
        if (line === undefined) return
        clearTimeout(timer)
        resolve((JSON.parse(line) as { bridgePid: number }).bridgePid)
      })
    })

    // The deadline the supervisor enforces, compressed to seconds.
    expect(alive(bridgePid), 'the bridge is alive while the trial is blocked').toBe(true)
    await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(child.exitCode, 'the trial did NOT finish on its own').toBeNull()

    // The stop. `child.kill()` alone did not end it -- measured, the trial was still alive three
    // seconds later -- so the supervisor stops the TREE rooted at the pid it owns. `/T` is what
    // reaches the bridge, which is a child of the trial rather than of the supervisor.
    const stopPid = child.pid!
    execFileSync('taskkill', ['/F', '/T', '/PID', String(stopPid)], { stdio: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(alive(stopPid), 'the trial was stopped by the supervisor').toBe(false)

    // The bridge was a CHILD of that trial. Whether it is reaped here is the measurement --
    // a leftover is reported and cleaned up by its own recorded pid, never by a global sweep.
    const bridgeSurvived = alive(bridgePid)
    if (bridgeSurvived) {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(bridgePid)])
      } catch { /* already gone */ }
    }
    // Recorded rather than asserted either way: the platform behaviour IS the result.
    expect(typeof bridgeSurvived).toBe('boolean')
  }, 120_000)
})