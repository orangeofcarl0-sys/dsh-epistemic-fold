/**
 * A bridge call that never answers must be BOUNDED, not waited on forever.
 *
 * ## The defect this pins
 *
 * `EpistemicFoldBridge._send` read the host's response with a bare
 * `self._proc.stdout.readline()`. That call has no timeout, and when the provider
 * accepts the connection and then never answers, the host blocks inside the model
 * call and this end blocks inside the read. Nothing in the system can notice.
 *
 * Measured on a live wave: eight cells frozen for more than thirty minutes, their
 * host processes alive but idle, `providerFailures` not advancing (so they were
 * not even cycling through backoff), no termination reason, and the wall-clock
 * draining. The host DOES carry a step deadline (EF_TAU2_STEP_TIMEOUT_MS), but a
 * deadline that never fires is indistinguishable from none, and the Python end had
 * no second line of defence.
 *
 * ## What the fix must preserve
 *
 * The timeout is reported in the SAME shape as a provider failure, because that is
 * what it is -- the model never replied -- so the agent's existing recovery
 * (backoff, PROVIDER_OUTAGE_MAX_SEC, MAX_WASTED_ATTEMPTS) stays in charge rather
 * than a second, competing recovery path being invented here.
 *
 * @module tests/bridge-read-timeout
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const CLIENT = readFileSync(join(ROOT, 'eval', 'bridge', 'ef_bridge_client.py'), 'utf8')

describe('a hung bridge call is bounded', () => {
  it('reads the response through a timeout instead of a bare readline', () => {
    expect(CLIENT, 'a bare readline() blocks forever and nothing can notice')
      .not.toMatch(/line = self\._proc\.stdout\.readline\(\)/u)
    expect(CLIENT).toMatch(/self\._readline\(self\._read_timeout_sec\)/u)
    expect(CLIENT).toMatch(/except queue\.Empty:/u)
  })

  it('pumps stdout on a thread, which is what makes the wait observable', () => {
    expect(CLIENT).toContain('import queue')
    expect(CLIENT).toContain('import threading')
    expect(CLIENT).toMatch(/threading\.Thread\(target=pump/u)
    expect(CLIENT).toMatch(/daemon=True/u)
    // EOF must wake a waiting reader, or the read becomes the hang again.
    expect(CLIENT).toMatch(/self\._lines\.put\(None\)/u)
  })

  it('starts the reader before any request can be sent', () => {
    const initAt = CLIENT.indexOf('self._start_reader()')
    const sendAt = CLIENT.indexOf('def _send(')
    expect(initAt, 'the reader must be started in __init__').toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(-1)
    // _start_reader() is called at construction; _send is a later method.
    expect(initAt).toBeLessThan(sendAt)
  })

  it('reports a hang as a provider failure, so one recovery path handles both', () => {
    const at = CLIENT.indexOf('except queue.Empty:')
    expect(at).toBeGreaterThan(-1)
    const branch = CLIENT.slice(at, at + 700)
    expect(branch, 'the agent retries on an `error` field, not on an exception')
      .toMatch(/"ok": True/u)
    expect(branch).toMatch(/"error":/u)
    // The bound must sit above the host's own step deadline, so a host that IS
    // enforcing its deadline still reports the failure itself.
    expect(CLIENT).toMatch(/EF_BRIDGE_READ_TIMEOUT_SEC/u)
    expect(CLIENT).toContain('1200')
  })
})
