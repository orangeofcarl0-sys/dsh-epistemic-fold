/**
 * The LHTB cell watchdog: sample every cell, classify, and reap what is stuck.
 *
 * ## Why this is not an agent
 *
 * The failures it looks for are deterministic, so an LLM would replace a comparison
 * with an uncertain call and add its own failure mode. There is also a stronger
 * reason: a supervisor that REPAIRS an episode becomes part of the measurement. If
 * it does the work, the cell scores agent+supervisor and the comparison against the
 * other arm is void. So this reaps a process that the harness already tried and
 * failed to kill, and it changes nothing else about the episode.
 *
 * ## What it does, and what it deliberately does not
 *
 * It kills ONLY when a cell is WEDGED — nothing written for longer than the shell
 * tool's own timeout — and even then only processes that outlived that timeout and
 * did NOT start with the container. The second condition is load-bearing: the
 * `unknown-config-semantics` image runs the TASK's own `cfg_daemon.py`, as old as
 * the container, and a rule based on age alone would have killed it and destroyed
 * every cell of that task.
 *
 * It does NOT nudge the model, retry a step, restart a cell, or edit a transcript. The
 * transcript records what the agent did; the watchdog's own log records what the
 * harness had to clean up, and the two are kept apart on purpose.
 *
 * Usage:
 *
 *     EF_WATCH_JOBS=<LHTB>/jobs EF_WATCH_LOG=<path> node --experimental-transform-types \
 *       eval/lhtb/watchdog.ts
 *
 * Exits on its own once no cell in the jobs root still has a running container.
 *
 * @module eval/lhtb/watchdog
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  classifyCell,
  DEFAULT_POLICY,
  parseProcessTable,
  selectStaleProcesses,
} from './watchdog-policy.ts'
import type { CellProcess, WatchdogPolicy } from './watchdog-policy.ts'

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: readonly string[],
  options?: { maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>

/** Jobs root holding one directory per sweep, each holding one directory per cell. */
const JOBS_ROOT = process.env.EF_WATCH_JOBS ?? ''
const LOG_PATH = process.env.EF_WATCH_LOG ?? 'lhtb-watchdog.log'
const HEARTBEAT_PATH = process.env.EF_WATCH_HEARTBEAT ?? ''
const INTERVAL_MS = Number(process.env.EF_WATCH_INTERVAL_SEC ?? 60) * 1_000
/** Consecutive rounds with no live container before the watchdog stands down. */
const IDLE_ROUNDS_BEFORE_EXIT = 3

/** One cell under watch. */
interface WatchedCell {
  readonly label: string
  readonly container: string
  readonly transcript: string
}

/** Thresholds, read per round so a long-lived watchdog can be retuned. */
function policy(): WatchdogPolicy {
  return {
    toolTimeoutSec: Number(process.env.EF_WATCH_TOOL_TIMEOUT_SEC ?? DEFAULT_POLICY.toolTimeoutSec),
    slackSec: Number(process.env.EF_WATCH_SLACK_SEC ?? DEFAULT_POLICY.slackSec),
    startupGraceSec: Number(process.env.EF_WATCH_STARTUP_GRACE_SEC ?? DEFAULT_POLICY.startupGraceSec),
    silenceSec: Number(process.env.EF_WATCH_SILENCE_SEC ?? DEFAULT_POLICY.silenceSec),
    stuckSec: Number(process.env.EF_WATCH_STUCK_SEC ?? DEFAULT_POLICY.stuckSec),
  }
}

/** Append one record. Never throws: a watchdog that dies stops watching. */
function record(entry: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* the log is not worth an episode */ }
}

/** Run one docker command, returning stdout. */
async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
  return stdout
}

/** Harbor names a cell's container after the cell directory, lowercased. */
function containerFor(cellDir: string): string {
  return cellDir.toLowerCase() + '-main-1'
}

/** Every cell that has a transcript, across every job directory. */
function discoverCells(root: string): WatchedCell[] {
  const cells: WatchedCell[] = []
  if (!existsSync(root)) return cells
  for (const job of readdirSync(root)) {
    const jobDir = join(root, job)
    try { if (!statSync(jobDir).isDirectory()) continue } catch { continue }
    for (const cell of readdirSync(jobDir)) {
      const transcript = join(jobDir, cell, 'agent', 'ef-transcript.json')
      if (!existsSync(transcript)) continue
      cells.push({ label: job.replace(/^lhtb-ef-[^-]*-/, '') + '/' + cell, container: containerFor(cell), transcript })
    }
  }
  return cells
}

/** Running container names, or `null` when docker itself could not be reached. */
async function runningContainers(): Promise<Set<string> | null> {
  try {
    const stdout = await docker(['ps', '--format', '{{.Names}}'])
    return new Set(stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
  } catch (error: unknown) {
    record({ event: 'docker-unavailable', error: String(error).slice(0, 200) })
    return null
  }
}

/**
 * Processes inside one container, or `null` when it could not be sampled.
 *
 * ## Why `docker top` and not `docker exec ps`
 *
 * The `unknown-config-semantics` image has NO `ps` binary — `docker exec … ps`
 * fails there with exit 127. That is how three of seven cells came back
 * `unsampled` on the first live run, i.e. the watchdog was blind to an entire
 * task. `docker top` reads the HOST's procfs, needs nothing installed in the
 * image, and returns the same three columns.
 */
async function processesIn(container: string): Promise<CellProcess[] | null> {
  try {
    const stdout = await docker(['top', container, '-eo', 'pid,etimes,args'])
    return parseProcessTable(stdout)
  } catch (error: unknown) {
    record({ event: 'sample-failed', container, error: String(error).slice(0, 200) })
    return null
  }
}

/** Kill the given PIDs through the container's own shell, so `kill` need not be a binary. */
async function reap(container: string, pids: readonly number[]): Promise<boolean> {
  try {
    await docker(['exec', container, 'sh', '-c', 'kill -9 ' + pids.join(' ')])
    return true
  } catch (error: unknown) {
    record({ event: 'reap-failed', container, pids, error: String(error).slice(0, 200) })
    return false
  }
}

/** One sampling round. Returns how many cells still had a running container. */
async function round(thresholds: WatchdogPolicy): Promise<number> {
  if (JOBS_ROOT === '') throw new Error('watchdog: EF_WATCH_JOBS is not set')
  const running = await runningContainers()
  if (running === null) return 1
  let live = 0
  for (const cell of discoverCells(JOBS_ROOT)) {
    if (!running.has(cell.container)) continue
    live += 1
    const processes = await processesIn(cell.container)
    if (processes === null) {
      record({ cell: cell.label, verdict: 'unsampled' })
      continue
    }
    let silentSec = -1
    try { silentSec = Math.round((Date.now() - statSync(cell.transcript).mtimeMs) / 1_000) } catch { /* gone */ }
    const verdict = classifyCell({ silentSec, processes }, thresholds)
    const stale = selectStaleProcesses(processes, thresholds)
    if (verdict === 'wedged') {
      const reaped = await reap(cell.container, stale.map(process => process.pid))
      record({
        cell: cell.label,
        verdict,
        silentSec,
        reaped,
        stale: stale.map(process => ({ pid: process.pid, elapsedSec: process.elapsedSec, args: process.args.slice(0, 90) })),
      })
    } else if (verdict === 'leaking') {
      // A WORKING cell's own leftovers. Recorded, never removed: these are usually
      // the agent's running benchmark servers, and killing them would change what
      // the cell measures rather than protect it.
      record({ cell: cell.label, verdict, silentSec, stale: stale.length })
    } else if (verdict === 'stuck') {
      record({ cell: cell.label, verdict, silentSec, processes: processes.length })
    }
  }
  if (HEARTBEAT_PATH !== '') {
    try {
      appendFileSync(HEARTBEAT_PATH, new Date().toISOString() + ' live=' + live + '\n')
    } catch { /* best effort */ }
  }
  return live
}

/** Sample until every watched cell has stopped running. */
async function main(): Promise<void> {
  record({ event: 'watchdog-start', jobsRoot: JOBS_ROOT, intervalMs: INTERVAL_MS })
  let idle = 0
  for (;;) {
    let live = 0
    try { live = await round(policy()) } catch (error: unknown) {
      record({ event: 'round-failed', error: String(error).slice(0, 300) })
      live = 1
    }
    idle = live === 0 ? idle + 1 : 0
    if (idle >= IDLE_ROUNDS_BEFORE_EXIT) {
      record({ event: 'watchdog-stop', reason: 'no running cells' })
      return
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
  }
}

main().catch((error: unknown) => {
  record({ event: 'watchdog-crash', error: String(error).slice(0, 300) })
  process.exitCode = 1
})
