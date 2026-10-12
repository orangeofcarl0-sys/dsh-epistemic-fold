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
  taskServiceDead,
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

/**
 * Reaps awaiting confirmation, by container.
 *
 * ## Why a kill is not an outcome
 *
 * Killing the stuck client is what SHOULD release the agent, and it did in the
 * two cases measured. But "the kill was issued" is not "the cell resumed", and the
 * first version of this logged `unblocked: true` and never looked again — so a cell
 * that stayed wedged was indistinguishable in the log from one that was saved.
 * That is the same failure as a reap that never fired: a record that reads like
 * success without being one.
 *
 * A reap is therefore confirmed against the NEXT samples: the transcript must move
 * within a couple of rounds, or it is recorded as ineffective.
 */
const pendingReaps = new Map<string, { round: number; silentSec: number }>()

/** Rounds elapsed with a silently wedged cell before a kill is called ineffective. */
const REAP_CONFIRM_ROUNDS = 2

/** Recently-written: a cell this active is making progress again. */
const RESUMED_SILENT_SEC = 120

let roundCounter = 0

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

/**
 * Unblock a wedged cell by killing the HOST-side `docker compose exec` client.
 *
 * ## Why the process INSIDE the container is the wrong target
 *
 * The first implementation killed the orphan by PID, using the PIDs that `docker
 * top` reported. Every single reap failed with `sh: 1: kill: No such process` —
 * because `docker top` reads the HOST's procfs, so those PIDs are host PIDs, and
 * they do not exist inside the container's PID namespace. The watchdog detected
 * correctly and did nothing, six times, which is worse than not detecting at all
 * because the log said the cells had been handled.
 *
 * ## What actually blocks the agent
 *
 * Harbor runs `docker compose --project-name <p> exec main …` and bounds it with
 * `timeout_sec`. On expiry it calls `process.terminate()`, waits, then
 * `process.kill()` — all on the LOCAL compose client — and then awaits
 * `communicate()` with no timeout. Measured: six of those clients sat on the host
 * for 37-59 minutes, and the agent was waiting the whole time. Killing the client is
 * what releases it, and it is exactly the step harbor intended to take.
 *
 * Killing the local client does leave the in-container orphan running; it holds a
 * port until the container is destroyed. That is accepted deliberately: the
 * alternative is the cell never continuing at all.
 *
 * @param project - the compose project name, which is the container name without its
 *   `-main-1` suffix.
 * @param minAgeSec - clients younger than this are left alone, because they may be a
 *   legitimate call still inside its own timeout.
 * @returns the PIDs killed.
 */
async function reapStuckClients(project: string, minAgeSec: number): Promise<number[]> {
  // Host process enumeration is Windows-specific here; elsewhere the watchdog still
  // detects and records, and simply cannot act. Stated rather than silently skipped.
  if (process.platform !== 'win32') return []
  const query = 'Get-CimInstance Win32_Process -Filter "Name=\'docker-compose.exe\' or Name=\'docker.exe\'"'
    + ' | Where-Object { $_.CommandLine -like \'*--project-name ' + project + '*\''
    + ' -and $_.CommandLine -like \'*exec*\''
    + ' -and ((Get-Date) - $_.CreationDate).TotalSeconds -gt ' + minAgeSec + ' }'
    + ' | ForEach-Object { $_.ProcessId }'
  let pids: number[] = []
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    )
    pids = stdout.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0)
  } catch (error: unknown) {
    record({ event: 'reap-query-failed', project, error: String(error).slice(0, 200) })
    return []
  }
  for (const pid of pids) {
    // `/T` so the whole client tree goes: the CLI and the compose plugin hold the
    // same pipe, so killing only one of them leaves the agent waiting.
    try {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 15_000 })
    } catch (error: unknown) {
      record({ event: 'reap-kill-failed', project, pid, error: String(error).slice(0, 160) })
    }
  }
  return pids
}

/** One sampling round. Returns how many cells still had a running container. */
async function round(thresholds: WatchdogPolicy): Promise<number> {
  if (JOBS_ROOT === '') throw new Error('watchdog: EF_WATCH_JOBS is not set')
  const running = await runningContainers()
  if (running === null) return 1
  roundCounter += 1
  // Every cell's silence THIS round, so a pending reap can be judged against a
  // fresh observation rather than against the one that triggered it.
  const observed = new Map<string, number>()
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
    observed.set(cell.container, silentSec)
    const verdict = classifyCell({ silentSec, processes }, thresholds)

    // ## A dead task service is terminal, and it outranks every liveness verdict
    //
    // The staged-config task's daemon consumes and DESTROYS its own secret on first start, so a
    // restart dies before it can listen and the episode becomes unwinnable. Liveness cannot see
    // this: the agent keeps writing the transcript and the container stays Up, so every other
    // verdict reads HEALTHY while the cell burns its whole budget producing nothing. Measured:
    // three samples served, then 24 crash-restarts at cfg_daemon.py line 111.
    //
    // Recorded as its own event, and stopped, because "the environment was broken" and "the model
    // could not do it" must not look the same in the results -- and because the only alternative is
    // spending the rest of the budget to produce nothing.
    const service = taskServiceDead(cell.container, processes, thresholds)
    if (service.dead) {
      let stopped = false
      try {
        await docker(['stop', '--time', '5', cell.container])
        stopped = true
      } catch (error: unknown) {
        record({ event: 'environment-dead-stop-failed', container: cell.container, error: String(error).slice(0, 160) })
      }
      record({
        cell: cell.label,
        verdict: 'environment-dead',
        silentSec,
        reason: service.reason,
        processes: processes.length,
        stopped,
      })
      continue
    }
    const stale = selectStaleProcesses(processes, thresholds)
    if (verdict === 'wedged') {
      // The compose project name is the container name without its `-main-1` suffix.
      const project = cell.container.replace(/-main-1$/u, '')
      // The SAME bound the verdict used, not the stale-process bound.
      //
      // These disagreed and it cost real time: the verdict fires at `toolTimeoutSec`
      // (900s), while the reap required a client older than `toolTimeout + slack`
      // (1200s), so two consecutive rounds logged a wedge as `unblocked: false` for a
      // client that was merely not yet old enough to touch. Measured on this run:
      // silent=1162s and 1223s both found nothing, then silent=1284s killed the
      // client — three minutes late, and the log blamed the wrong thing.
      //
      // 900s is already the right bound: harbor's own timeout fires there, so a
      // client still alive past it is a client harbor failed to kill.
      const killed = await reapStuckClients(project, thresholds.toolTimeoutSec)
      if (killed.length > 0) {
        // Judged on the NEXT samples, not claimed here: a kill is an action, not an
        // outcome, and the first version logged it as one.
        pendingReaps.set(cell.container, { round: roundCounter, silentSec })
      }
      record({
        cell: cell.label,
        verdict,
        silentSec,
        // An EMPTY `killed` means the client was already gone and the agent is blocked
        // somewhere this watchdog cannot reach. It is reported as such rather than as
        // a success, which is the mistake the first implementation made: it logged a
        // reap for six cells whose agents never moved.
        killed,
        unblocked: killed.length > 0,
        stale: stale.map(process => ({
          pid: process.pid,
          elapsedSec: process.elapsedSec,
          args: process.args.slice(0, 90),
        })),
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
  // ## Did the kill actually release the agent?
  //
  // The check the first version lacked, and why a dead reap and a successful one
  // produced the same log line: the outcome was never observed.
  for (const [container, entry] of pendingReaps) {
    const silence = observed.get(container)
    if (silence === undefined) continue
    if (silence <= RESUMED_SILENT_SEC) {
      record({ event: 'reap-confirmed', container, afterRounds: roundCounter - entry.round,
        silentAtKill: entry.silentSec, silentNow: silence })
      pendingReaps.delete(container)
    } else if (roundCounter - entry.round >= REAP_CONFIRM_ROUNDS) {
      // The client was killed and the cell is STILL silent: either it re-wedged on a
      // new call, or the block was never a host client. Saying so is the point --
      // otherwise the next reader assumes the reap worked.
      record({ event: 'reap-ineffective', container, afterRounds: roundCounter - entry.round,
        silentAtKill: entry.silentSec, silentNow: silence })
      pendingReaps.delete(container)
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
