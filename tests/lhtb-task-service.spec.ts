/**
 * The task service is single-use, so a restart is terminal -- and silent.
 *
 * Measured on a live cell: actions.log recorded three samples, then daemon.log accumulated 24
 * crashes at cfg_daemon.py line 111 (KeyError: seed). Every cfg command returned nothing, so the
 * episode was unwinnable while the container stayed Up, Harbor stayed running, and the transcript
 * kept being written. Nothing reported it; the cell spent its whole budget producing nothing.
 *
 * @module tests/lhtb-task-service
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY,
  taskServiceDead,
  type CellProcess,
} from '../eval/lhtb/watchdog-policy.ts'

const CONTAINER = 'unknown-config-semantics__abc123-main-1'
/** One process row, as docker top reports it. */
const proc = (elapsedSec: number, args: string, pid = 1): CellProcess => ({ pid, elapsedSec, args })

describe('taskServiceDead', () => {
  it('ignores containers that do not run a single-use service', () => {
    // The guard that matters most: most tasks have no such service, and a rule that looked for a
    // missing process unconditionally would declare every healthy cell of every other task dead.
    const v = taskServiceDead('vector-db-iterative-build__x-main-1', [proc(600, 'sleep infinity')])
    expect(v.dead).toBe(false)
  })

  it('calls it dead when the service is not running at all', () => {
    const v = taskServiceDead(CONTAINER, [proc(600, 'sh -c sleep infinity'), proc(600, 'sleep infinity')])
    expect(v.dead).toBe(true)
    expect(v.reason).toContain('not running')
  })

  it('accepts a service that is as old as the container', () => {
    const v = taskServiceDead(CONTAINER, [
      proc(600, 'sh -c sleep infinity'),
      proc(599, 'python3 /opt/cfg/cfg_daemon.py'),
    ])
    expect(v.dead).toBe(false)
  })

  it('calls it dead when the service restarted', () => {
    // 600s container, 30s service: it came back long after the container did, and a restart
    // cannot succeed because the first start consumed the only copy of the secret.
    const v = taskServiceDead(CONTAINER, [
      proc(600, 'sh -c sleep infinity'),
      proc(30, 'python3 /opt/cfg/cfg_daemon.py'),
    ])
    expect(v.dead).toBe(true)
    expect(v.reason).toContain('restarted')
  })

  it('does not judge when the service is the only process', () => {
    // No init to date the container against. Guessing here would be a false positive.
    const v = taskServiceDead(CONTAINER, [proc(600, 'python3 /opt/cfg/cfg_daemon.py')])
    expect(v.dead).toBe(false)
  })

  it('respects the startup grace', () => {
    const withinGrace = DEFAULT_POLICY.startupGraceSec - 1
    const v = taskServiceDead(CONTAINER, [
      proc(600, 'sh -c sleep infinity'),
      proc(600 - withinGrace, 'python3 /opt/cfg/cfg_daemon.py'),
    ])
    expect(v.dead).toBe(false)
  })
})
