/**
 * What an LHTB cell's liveness sample MEANS, as pure logic.
 *
 * ## The failure this exists for
 *
 * A cell can stop making progress without failing. Measured in the step-5 round: two
 * `vector-db` cells wrote nothing for 1h35m and 3h10m while their containers stayed
 * `Up` and the trials stayed `in-progress`. One held SIXTEEN orphaned processes,
 * aged up to 2h54m, and the other held a `bash`+`python3` pair aged 3h22m — all at
 * 0% CPU. The agent had written itself a raw-socket benchmark server that deadlocked,
 * which is the agent's own bug; the multi-hour consequence is the harness's, because
 * the shell tool's 900-second timeout kills the LOCAL `docker compose` client and
 * never the process inside the container, which then holds the pipe open so the
 * waiting call never returns.
 *
 * ## Rule 1: silence is not evidence
 *
 * A model call on this route takes 34-241 seconds, so a cell that has written nothing
 * for two minutes is HEALTHY. A 75-second sampling window once caught only 1 of 8
 * working cells mid-call, which a silence-based detector would have read as seven
 * wedges. The definitive signal is a process that outlived the timeout it was subject
 * to: nothing legitimate can do that, because the harness would have ended the call.
 *
 * ## Rule 2: "old" is not the same as "orphaned"
 *
 * This is the rule that a live sample forced, and it is the dangerous one. The
 * `unknown-config-semantics` image runs `/opt/cfg/cfg_daemon.py` — the TASK's own
 * service, a child of the container init and exactly as old as the container. A rule
 * that reaped every sufficiently old process would have killed the task's daemon and
 * silently destroyed every cell of that task. So a process that started with the
 * container is not a candidate at all, however old it is.
 *
 * ## Rule 3: only a WEDGED cell is touched
 *
 * One `economy` cell was making progress normally while holding five leftover
 * `python3` servers of its own, up to 1h32m old. Those are the agent's own running
 * experiments, not garbage: a cell that is still working is left alone, and its
 * leftovers are recorded but not removed.
 *
 * @module eval/lhtb/watchdog-policy
 */

/** One process as the container reports it. */
export interface CellProcess {
  readonly pid: number
  readonly elapsedSec: number
  readonly args: string
}

/** Thresholds. Split out so a test can pin them without running docker. */
export interface WatchdogPolicy {
  /** The shell tool's own timeout, mirrored from the agent (harbor's `timeout_sec`). */
  readonly toolTimeoutSec: number
  /** Grace beyond that timeout before a surviving process counts as orphaned. */
  readonly slackSec: number
  /** How long a process may have been running before it counts as `stale` at all. */
  readonly startupGraceSec: number
  /** Silence beyond one plausible model call, but not yet alarming. */
  readonly silenceSec: number
  /** Silence with nothing running at all: a call that will never return. */
  readonly stuckSec: number
}

/** The defaults, matching the harness as measured. */
export const DEFAULT_POLICY: WatchdogPolicy = {
  toolTimeoutSec: 900,
  slackSec: 300,
  startupGraceSec: 300,
  silenceSec: 300,
  stuckSec: 1_800,
}

/**
 * What the watchdog concluded about one cell.
 *
 * `leaking` is deliberately NOT an error: it says a working cell is holding
 * leftovers, which is normal for an agent running its own benchmark servers.
 */
export type CellVerdict = 'wedged' | 'leaking' | 'stuck' | 'quiet' | 'active'

/** One sample of one cell. */
export interface LivenessSample {
  /** Seconds since the cell's transcript was last written. */
  readonly silentSec: number
  /** Processes inside the cell's container, as sampled. */
  readonly processes: readonly CellProcess[]
}

/**
 * The container's own age.
 *
 * Taken as the OLDEST process rather than from `pid === 1`, because the two
 * sampling paths disagree about what a PID means: `docker exec ps` reports
 * container PIDs (init is 1), while `docker top` reads the host's procfs and
 * reports host PIDs (the init is whatever the host assigned it). The oldest
 * process is the container's init under both, so it is the portable answer.
 * @param processes - every process the container reported.
 * @returns the age in seconds, or `Infinity` for an empty sample.
 */
function containerAgeSec(processes: readonly CellProcess[]): number {
  let oldest = Number.NEGATIVE_INFINITY
  for (const process of processes) {
    if (process.elapsedSec > oldest) oldest = process.elapsedSec
  }
  return oldest === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : oldest
}

/**
 * Processes that outlived the timeout that was supposed to kill them.
 *
 * Excluded: the container init and its keepalive, which are as old as the container
 * by construction; anything that started WITH the container, because that is a task
 * service rather than a leftover (`cfg_daemon.py` is the measured case); and anything
 * still inside the tool's own timeout window.
 * @param processes - every process the container reported.
 * @param policy - thresholds; defaults to {@link DEFAULT_POLICY}.
 * @returns the orphans, in the order given.
 */
export function selectStaleProcesses(
  processes: readonly CellProcess[],
  policy: WatchdogPolicy = DEFAULT_POLICY,
): CellProcess[] {
  const threshold = policy.toolTimeoutSec + policy.slackSec
  // A service that came up with the container is never a leftover, however old.
  const serviceCutoff = containerAgeSec(processes) - policy.startupGraceSec
  return processes.filter(process => (
    process.pid !== 1
    && process.elapsedSec > threshold
    && process.elapsedSec < serviceCutoff
    && !/sleep infinity/u.test(process.args)
  ))
}

/**
 * Read one sample as a verdict.
 *
 * `wedged` requires BOTH an orphan and a cell that is not progressing: an orphan
 * beside a working cell is the cell's own experiment, and touching it would change
 * the measurement rather than protect it.
 * @param sample - the sample.
 * @param policy - thresholds; defaults to {@link DEFAULT_POLICY}.
 * @returns the verdict.
 */
export function classifyCell(
  sample: LivenessSample,
  policy: WatchdogPolicy = DEFAULT_POLICY,
): CellVerdict {
  const stale = selectStaleProcesses(sample.processes, policy)
  if (stale.length > 0) {
    return sample.silentSec >= policy.toolTimeoutSec ? 'wedged' : 'leaking'
  }
  if (sample.silentSec > policy.stuckSec) return 'stuck'
  if (sample.silentSec > policy.silenceSec) return 'quiet'
  return 'active'
}

/**
 * Parse `docker top <c> -eo pid,etimes,args` output.
 *
 * `args` is everything after the second column: a command line contains spaces, and
 * splitting on them would truncate it into something that could then be matched
 * against the keepalive pattern — the one test that must never produce a false
 * positive.
 *
 * The numeric first column also skips the header, so no special case is needed.
 * @param text - the raw output, one process per line.
 * @returns the parsed processes, skipping the header and any unparsable line.
 */
export function parseProcessTable(text: string): CellProcess[] {
  const parsed: CellProcess[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line)
    if (match === null) continue
    parsed.push({ pid: Number(match[1]), elapsedSec: Number(match[2]), args: match[3]! })
  }
  return parsed
}

/**
 * ## Rule 4: the task's own service is SINGLE-USE, and a restart cannot succeed
 *
 * The staged-config task runs /opt/cfg/cfg_daemon.py, which on its first successful start merges
 * its private half and then DESTROYS the only copy on disk:
 *
 *     def _consume_secret(self):
 *         """Merge the private half, then DESTROY the only copy on disk."""
 *
 * Every later start therefore dies before it can listen, with KeyError: 'seed':
 *
 *     File "/opt/cfg/cfg_daemon.py", line 111, in __init__
 *       self.seed = self.data["seed"]
 *
 * Measured on a live cell: actions.log recorded three samples and then stopped, while daemon.log
 * accumulated 24 such crashes. cfg status, cfg sample and cfg probe all returned nothing, so the
 * episode had become UNWINNABLE -- and nothing reported it. The container stayed Up, Harbor stayed
 * running, the transcript kept being written, and the cell spent its full budget producing nothing.
 *
 * This is why it never appeared in the step-5 round: the daemon is only ever started ONCE there,
 * because that round's model went straight at the task. A stronger model goes looking for the
 * private data -- reading /proc/<pid>/mem, decompiling __pycache__/cfg_daemon.cpython-*.pyc,
 * hunting for a secret file -- and something in that hunt ends the daemon. So the defect is
 * SELECTIVE AGAINST STRONGER MODELS, which is a validity problem, not an operations one.
 *
 * The detection is cheap and needs no new sampling: the service must be as old as the container,
 * because the container's own entrypoint starts it. A service younger by more than the startup
 * grace has restarted, and a restart cannot succeed. Rule 2 already says such a process "is not a
 * candidate at all, however old it is" -- this is the other half of that same fact.
 *
 * Scoped by CONTAINER NAME on purpose. Most tasks have no such service, and a rule that looked for
 * a missing process unconditionally would declare every healthy cell of every other task dead.
 */
export interface TaskServiceRule {
  /** Only containers matching this are subject to the rule. */
  readonly containerPattern: RegExp
  /** The service that must be present, and as old as the container. */
  readonly processPattern: RegExp
}

/** The measured case: the staged-config task's daemon. */
export const DEFAULT_TASK_SERVICE: TaskServiceRule = {
  containerPattern: /unknown-config-semantics/u,
  processPattern: /cfg_daemon[.]py/u,
}

/** Whether the task's own service is gone or has restarted, and why. */
export interface TaskServiceVerdict {
  readonly dead: boolean
  readonly reason: string
}

/**
 * Is the task's own service gone, or younger than the container that started it?
 *
 * @param container - the container name, used to scope the rule.
 * @param processes - every process the container reported.
 * @param policy - thresholds; defaults to DEFAULT_POLICY.
 * @param rule - which container and which service; defaults to the measured case.
 * @returns whether the environment is dead, and the evidence.
 */
export function taskServiceDead(
  container: string,
  processes: readonly CellProcess[],
  policy: WatchdogPolicy = DEFAULT_POLICY,
  rule: TaskServiceRule = DEFAULT_TASK_SERVICE,
): TaskServiceVerdict {
  if (!rule.containerPattern.test(container)) {
    return { dead: false, reason: 'not a task that runs a single-use service' }
  }
  const service = processes.find(process => rule.processPattern.test(process.args))
  if (service === undefined) {
    return { dead: true, reason: 'the task service is not running at all' }
  }
  // The container's age from everything EXCEPT the service, so the comparison is meaningful.
  const others = processes.filter(process => process !== service)
  if (others.length === 0) {
    return { dead: false, reason: 'no other process to date the container against' }
  }
  const age = containerAgeSec(others)
  const younger = age - service.elapsedSec
  if (younger > policy.startupGraceSec) {
    return {
      dead: true,
      reason: 'the task service restarted: ' + younger + 's younger than the container, and a'
        + ' restart cannot succeed because the first start consumed the only copy of its secret',
    }
  }
  return { dead: false, reason: 'the task service is as old as the container' }
}
