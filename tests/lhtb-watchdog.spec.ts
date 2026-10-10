/**
 * The watchdog notices a cell that stopped making progress, and ONLY that.
 *
 * Every case below is taken from a live sample of the step-5 round, because both of
 * the ways this can go wrong were found there rather than reasoned about:
 *
 * FALSE NEGATIVE. Two `vector-db` cells wrote nothing for 1h35m and 3h10m while
 * their containers stayed up and the trials stayed `in-progress`. One held sixteen
 * orphans aged up to 2h54m; the shell tool's 900-second timeout kills the local
 * `docker compose` client, never the process in the container.
 *
 * FALSE POSITIVE, and this is the dangerous one. A first draft reaped every
 * sufficiently old process. Sampling the `unknown-config-semantics` image showed
 * `/opt/cfg/cfg_daemon.py` — the TASK's own service, a child of the container init
 * and as old as the container. That draft would have killed it and destroyed every
 * cell of that task. A second draft reaped any orphan it saw; an `economy` cell was
 * then found working normally while holding five of its own leftover servers up to
 * 1h32m old, which are experiments rather than garbage.
 *
 * @module tests/lhtb-watchdog
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyCell,
  DEFAULT_POLICY,
  parseProcessTable,
  selectStaleProcesses,
} from '../eval/lhtb/watchdog-policy.ts'

/** A wedged `vector-db` cell, shaped exactly as `docker exec ps` reported it. */
const WEDGED_PS = [
  '    PID ELAPSED COMMAND',
  '      1   13181 sh -c sleep infinity',
  '      8   13181 sleep infinity',
  '    267   11406 bash -c cat > /tmp/exp.py << PYEOF import socket ...',
  '    274   11406 python3 /tmp/exp.py',
  '    306       0 ps -eo pid,etimes,args',
].join('\n')

/**
 * A healthy `unknown-config-semantics` cell, shaped as `docker top` reported it.
 *
 * Note the HOST pids: there is no pid 1 here at all, which is why the container's
 * age is read from the oldest process rather than from the init's pid.
 */
const TASK_DAEMON_PS = [
  'PID                 ELAPSED             COMMAND',
  '22524               14029               sh -c sleep infinity',
  '22560               14029               sleep infinity',
  '23102               13967               /usr/local/bin/python3 /opt/cfg/cfg_daemon.py',
].join('\n')

/** A WORKING cell holding its own long-lived benchmark servers. */
const LEAKING_PS = [
  'PID                 ELAPSED             COMMAND',
  '22696               14004               sh -c sleep infinity',
  '22715               14004               sleep infinity',
  '49552               1313                python3 /tmp/srv/dual.py',
  '46100               5559                python3 /tmp/srv/raw.py',
].join('\n')

describe('parsing the process table', () => {
  it('keeps a command line whole, because splitting it truncates the match', () => {
    const processes = parseProcessTable(WEDGED_PS)
    expect(processes.map(process => process.pid)).toEqual([1, 8, 267, 274, 306])
    expect(processes[2]!.args).toContain('cat > /tmp/exp.py')
    expect(processes[3]!.elapsedSec).toBe(11_406)
  })

  it('skips the header and anything unparsable, inventing nothing', () => {
    expect(parseProcessTable('    PID ELAPSED COMMAND\n\nnot a row\n')).toEqual([])
  })
})

describe('separating an orphan from the task service it must not touch', () => {
  it('selects the orphans whose timeout failed to reap them', () => {
    const stale = selectStaleProcesses(parseProcessTable(WEDGED_PS))
    expect(stale.map(process => process.pid)).toEqual([267, 274])
  })

  it('NEVER selects the task daemon, which is as old as the container', () => {
    // The measured failure mode of the first draft: 13967 seconds old, a child of
    // the container init, and entirely legitimate. Reaping it would not un-wedge
    // anything — it would quietly invalidate every cell of that task.
    const processes = parseProcessTable(TASK_DAEMON_PS)
    // Three ROWS are processes; the fourth line is the header, which the numeric
    // first column already skips.
    expect(processes.length, 'the sample must contain the daemon').toBe(3)
    expect(selectStaleProcesses(processes)).toEqual([])
  })

  it('still sees an orphan in that same container shape', () => {
    // The daemon exclusion must not blind the detector to a real orphan beside it.
    const processes = parseProcessTable(TASK_DAEMON_PS)
    processes.push({ pid: 31_000, elapsedSec: 9_000, args: 'python3 /tmp/hung.py' })
    expect(selectStaleProcesses(processes).map(process => process.pid)).toEqual([31_000])
  })

  it('never selects the container init or its keepalive', () => {
    const stale = selectStaleProcesses([
      { pid: 1, elapsedSec: 99_999, args: 'sh -c sleep infinity' },
      { pid: 8, elapsedSec: 99_999, args: 'sleep infinity' },
    ])
    expect(stale).toEqual([])
  })

  it('leaves a command that is merely still inside its own timeout alone', () => {
    // The tool is allowed 900 seconds. Killing at 899 would break a call that was
    // about to succeed.
    const stale = selectStaleProcesses([
      { pid: 42, elapsedSec: DEFAULT_POLICY.toolTimeoutSec, args: 'python3 slow-but-fine.py' },
    ])
    expect(stale).toEqual([])
  })
})

describe('reading a sample as a verdict', () => {
  it('calls the wedged cell wedged', () => {
    expect(classifyCell({
      silentSec: 11_131,
      processes: parseProcessTable(WEDGED_PS),
    })).toBe('wedged')
  })

  it('calls a mid-call cell ACTIVE, not wedged', () => {
    // The false positive that would have hidden the real ones behind noise: two
    // minutes of silence with nothing left running is a model call in flight.
    expect(classifyCell({ silentSec: 241, processes: [] })).toBe('active')
  })

  it('records an orphan beside a WORKING cell as leaking, and does not act on it', () => {
    // Five leftover servers, up to 1h32m old, in a cell that was still making
    // progress. They are the agent's own experiments; removing them would change
    // what the cell measures.
    expect(classifyCell({
      silentSec: 127,
      processes: parseProcessTable(LEAKING_PS),
    })).toBe('leaking')
  })

  it('separates quiet from stuck, because only one of them is a problem', () => {
    expect(classifyCell({ silentSec: 600, processes: [] })).toBe('quiet')
    expect(classifyCell({ silentSec: 3_600, processes: [] })).toBe('stuck')
  })

  it('never calls the healthy task-daemon cell wedged, however quiet it is', () => {
    expect(classifyCell({
      silentSec: 4_000,
      processes: parseProcessTable(TASK_DAEMON_PS),
    })).toBe('stuck')
  })
})

describe('the ACTION must kill the process that is actually blocking the agent', () => {
  const RUNNER = readFileSync(join(import.meta.dirname, '..', 'eval', 'lhtb', 'watchdog.ts'), 'utf8')

  it('kills the HOST-side compose client, which is what the agent is waiting on', () => {
    // Measured: six of these sat on the host for 37-59 minutes while their agents
    // waited. Harbor tried to kill them, then awaited communicate() with no timeout.
    expect(RUNNER).toContain('docker-compose.exe')
    expect(RUNNER).toContain('docker.exe')
    expect(RUNNER).toContain('--project-name')
    expect(RUNNER).toContain("execFileAsync('taskkill'")
  })

  it('never kills INSIDE the container by a host PID', () => {
    // The measured no-op. docker top reports host PIDs, which do not exist in the
    // container's PID namespace, so every reap failed with "No such process" while
    // the log recorded the cells as handled. Detecting without acting is worse than
    // not detecting, because the log lies.
    // The old shape was `docker(['exec', container, 'sh', '-c', 'kill -9 …'])`, and
    // every call to it failed. Pinned as literal text so it cannot come back.
    expect(RUNNER).not.toContain("'exec', container")
    expect(RUNNER).not.toContain("'kill -9 '")
  })

  it('kills the whole client tree, because two processes share one pipe', () => {
    // The CLI and the compose plugin both hold the write end: killing only the
    // plugin left two cells waiting exactly as before.
    expect(RUNNER).toContain("'/F', '/T', '/PID'")
  })

  it('derives the compose project name from the container name', () => {
    expect(RUNNER).toContain("cell.container.replace(/-main-1$/u, '')")
  })

  it('records an unreachable block as UNREACHABLE, not as a success', () => {
    expect(RUNNER).toContain('unblocked: killed.length > 0')
  })

  it('acts on the SAME bound the verdict used, so "unreachable" means unreachable', () => {
    // The two thresholds disagreed (900s to declare, 1200s to act), so a wedged
    // cell was logged as UNREACHABLE for two rounds while the client was simply not
    // yet old enough. Measured: silent=1162s and 1223s found nothing, 1284s killed
    // it. An action that lags its own verdict by minutes, and blames the wrong
    // cause in the log, is worse than a slower action honestly labelled.
    expect(RUNNER).toContain('reapStuckClients(project, thresholds.toolTimeoutSec)')
    expect(RUNNER).not.toContain('toolTimeoutSec + thresholds.slackSec)')
  })
})
