/**
 * One global budget for an entire live run, enforced at the HTTP-attempt edge.
 *
 * ## What was wrong in R33
 *
 * R33 wrapped the adapter's `stream()` and charged one request there. The
 * OpenAI-compatible adapter retries HTTP 429 internally, so one `stream()` could
 * be two, three, or four real HTTP requests and the ledger saw one. The budget
 * was therefore not a budget: it counted turns, not attempts.
 *
 * This ledger implements the interface the adapter already calls at exactly the
 * right boundary (`budget.admit` immediately before `fetch`, `budget.record`
 * after a response). One HTTP attempt is one admission and one attempt record.
 * A 429 resend is a new admission. An attempt the adapter provably never sent
 * (DNS/connection failure) is released; an attempt that may have been processed
 * keeps its conservative reservation charged.
 *
 * ## Honest accounting
 *
 * Three quantities are kept apart and are never presented as each other:
 *
 *   observed   the provider reported it (input, output, cache read/write)
 *   reserved   the request was admitted but its true cost is unknown
 *   charged    observed + reserved, what admission compares against the limit
 *
 * A provider that omits `completion_tokens` does NOT make the output free: that
 * dimension keeps its reserve and the request is counted as partial. An absent
 * usage record keeps the whole reserve and counts as unknown.
 *
 * ## Immutability
 *
 * `snapshot()` returns a frozen copy. R33 returned `this.used` itself, so a
 * before/after subtraction over two snapshots was a subtraction from the same
 * object and every per-case cost read as zero or the full run.
 *
 * @module eval/r33/src/budget
 */

import { readFile } from 'node:fs/promises'

export const BUDGET_SCHEMA_VERSION = 2

export const RUN_STATUS = [
  'not-executed',
  'executed-success',
  'executed-partial',
  'executed-failed',
  'budget-exhausted',
  'provider-unavailable',
  'invalid-benchmark',
]

/** Exit codes an automation can branch on, one per status. */
export const STATUS_EXIT_CODE = {
  'executed-success': 0,
  'executed-partial': 2,
  'not-executed': 3,
  'budget-exhausted': 4,
  'provider-unavailable': 5,
  'invalid-benchmark': 6,
  'executed-failed': 7,
}

export class BudgetExhausted extends Error {
  constructor(reason, snapshot) {
    super(`global R33 budget exhausted: ${reason}`)
    this.name = 'BudgetExhausted'
    /** The same discriminator the adapter's RequestBudget uses. */
    this.code = 'BUDGET_EXHAUSTED'
    this.reason = reason
    if (snapshot !== undefined) this.snapshot = snapshot
  }
}

/** A JSON deep copy. Values are plain data; this is not a general clone. */
function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * The shared ledger.
 *
 * It implements the same four methods the adapter's `RequestBudget` exposes —
 * `admit`, `settle`, `release`, `record` — so the adapter needs no second
 * counting path and the admission happens before the request is sent.
 */
export class BudgetLedger {
  /**
   * @param {object} limits - positive totals for the whole run.
   * @param {{maxRequestOutputTokens?: number}} [options]
   */
  constructor(limits, options = {}) {
    this.limitsValue = Object.freeze({ ...limits })
    this.maxRequestOutputTokens = positiveInteger(options.maxRequestOutputTokens)
      ? options.maxRequestOutputTokens
      : undefined
    this.attempts = 0
    this.refusalCount = 0
    this.retryCount = 0
    this.observed = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    this.reservedValue = { requests: 0, inputTokens: 0, outputTokens: 0 }
    this.unknownUsageRequests = 0
    this.partialUsageRequests = 0
    /** Reservations not yet settled, oldest first. */
    this.outstanding = []
    this.nextReservationId = 1
    this.startedAt = Date.now()
  }

  get limits() {
    return this.limitsValue
  }

  /** Wall-clock used, including time spent waiting on providers. */
  elapsedMs() {
    return Date.now() - this.startedAt
  }

  /** Whether a new attempt of the given size can be admitted. */
  canReserve(estimate) {
    const snap = this.snapshot()
    if (this.attempts >= this.limitsValue.requests) return 'requests'
    if (snap.charged.inputTokens + estimate.inputTokens > this.limitsValue.inputTokens) {
      return 'inputTokens'
    }
    if (snap.charged.outputTokens + estimate.outputTokens > this.limitsValue.outputTokens) {
      return 'outputTokens'
    }
    if (this.elapsedMs() >= this.limitsValue.wallClockMs) return 'wallClockMs'
    return undefined
  }

  /**
   * Admit one HTTP attempt, or refuse it.
   *
   * The adapter calls this immediately before `fetch`, including for a 429
   * resend. A refusal throws BEFORE the request exists, so an exhausted budget
   * prevents the request instead of describing the overspend.
   *
   * @param {{promptTokens?: number, outputTokens?: number}} [requestReserve]
   * @returns {{id:number, inputTokens:number, outputTokens:number}}
   */
  admit(requestReserve) {
    const inputTokens = requestReserve?.promptTokens
    const outputTokens = requestReserve?.outputTokens
    if (!Number.isFinite(inputTokens) || inputTokens < 0) {
      this.refusalCount += 1
      throw new BudgetExhausted('unknown-input-bound', this.snapshot())
    }
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
      this.refusalCount += 1
      throw new BudgetExhausted('unknown-output-bound', this.snapshot())
    }
    if (this.maxRequestOutputTokens !== undefined && outputTokens > this.maxRequestOutputTokens) {
      this.refusalCount += 1
      throw new BudgetExhausted('output-reserve-exceeds-approved-max', this.snapshot())
    }
    const reason = this.canReserve({ inputTokens, outputTokens })
    if (reason !== undefined) {
      this.refusalCount += 1
      throw new BudgetExhausted(reason, this.snapshot())
    }
    this.attempts += 1
    this.reservedValue.requests += 1
    this.reservedValue.inputTokens += inputTokens
    this.reservedValue.outputTokens += outputTokens
    const reservation = {
      id: this.nextReservationId,
      inputTokens,
      outputTokens,
    }
    this.nextReservationId += 1
    this.outstanding.push(reservation)
    return reservation
  }

  /** Remove one reservation from the outstanding list. */
  settle(reservation) {
    if (reservation !== undefined) {
      const at = this.outstanding.findIndex(entry => entry.id === reservation.id)
      if (at >= 0) {
        this.outstanding.splice(at, 1)
        return
      }
    }
    this.outstanding.shift()
  }

  /**
   * Give a reservation back WITHOUT recording consumption.
   *
   * Only for a request that provably never left the machine. The attempt stays
   * counted (it happened), but its token reserve is released.
   */
  release(reservation) {
    if (reservation === undefined) return
    const at = this.outstanding.findIndex(entry => entry.id === reservation.id)
    if (at < 0) return
    const [settled] = this.outstanding.splice(at, 1)
    this.reservedValue.requests = Math.max(0, this.reservedValue.requests - 1)
    this.reservedValue.inputTokens = Math.max(0, this.reservedValue.inputTokens - settled.inputTokens)
    this.reservedValue.outputTokens = Math.max(0, this.reservedValue.outputTokens - settled.outputTokens)
  }

  /**
   * Record a rate-limited attempt.
   *
   * A 429 produced no generation, but its true cost is UNKNOWN, not zero: the
   * reserve stays charged and the request is counted as unknown. Releasing it
   * would let a provider's throttling make requests look free, which is the
   * accounting error R33's `?? 0` made in a different form. The next attempt
   * is admitted separately, so a 429 can never bypass the total budget.
   */
  retry(reservation) {
    this.retryCount += 1
    this.unknownUsageRequests += 1
    // `reservation` deliberately remains in `outstanding`: its charge stands.
    void reservation
  }

  /**
   * Settle one attempt with the provider's usage.
   *
   * Per-dimension, exactly like the adapter's RequestBudget: an unreported
   * dimension keeps its reserve. This is what prevents a partial usage record
   * from turning an unknown cost into a free one.
   *
   * @param {object|undefined} usage
   * @param {object|undefined} _fallback - unused; the reserve is the fallback
   * @param {{prompt: boolean, output: boolean}} reported
   * @param {{id:number}|undefined} reservation
   */
  record(usage, _fallback, reported = { prompt: true, output: true }, reservation) {
    const at = reservation === undefined
      ? 0
      : this.outstanding.findIndex(entry => entry.id === reservation.id)
    const settled = at >= 0 ? this.outstanding[at] : undefined
    if (at >= 0) this.outstanding.splice(at, 1)
    if (settled !== undefined) {
      this.reservedValue.requests = Math.max(0, this.reservedValue.requests - 1)
    }
    if (usage === undefined) {
      this.unknownUsageRequests += 1
      // The whole reserve stands: an unreported request is not free.
      return
    }
    const promptReported = reported.prompt === true
    const outputReported = reported.output === true
    if (!promptReported || !outputReported) this.partialUsageRequests += 1
    if (settled !== undefined) {
      if (promptReported) {
        this.reservedValue.inputTokens = Math.max(0, this.reservedValue.inputTokens - settled.inputTokens)
      }
      if (outputReported) {
        this.reservedValue.outputTokens = Math.max(0, this.reservedValue.outputTokens - settled.outputTokens)
      }
    }
    if (promptReported) {
      const prompt = (Number(usage.inputTokens) || 0)
        + (Number(usage.cacheReadTokens) || 0)
        + (Number(usage.cacheWriteTokens) || 0)
        + (Number(usage.promptTokens) || 0)
      if (Number.isFinite(prompt) && prompt >= 0) this.observed.inputTokens += prompt
    }
    if (outputReported && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
      this.observed.outputTokens += usage.outputTokens
    }
    if (Number.isFinite(usage.cacheReadTokens) && usage.cacheReadTokens >= 0) {
      this.observed.cacheReadTokens += usage.cacheReadTokens
    }
    if (Number.isFinite(usage.cacheWriteTokens) && usage.cacheWriteTokens >= 0) {
      this.observed.cacheWriteTokens += usage.cacheWriteTokens
    }
  }

  /**
   * Admit a non-HTTP call (the scripted adapter in `--self-test`).
   *
   * Kept as a separate name so nobody mistakes it for the HTTP boundary. A live
   * provider call must use `admit`, which the adapter invokes per attempt.
   */
  reserve(estimate) {
    return this.admit({
      promptTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
    })
  }

  /** Settle a non-HTTP call. `usage === undefined` keeps the whole reserve. */
  recordStream({ usage, retry = false, reservation }) {
    if (retry) this.retryCount += 1
    this.record(
      usage,
      undefined,
      { prompt: usage !== undefined, output: usage !== undefined },
      reservation,
    )
  }

  /** Explicit retry telemetry, used only when an adapter can report it. */
  noteRetry() {
    this.retryCount += 1
  }

  /** A frozen, point-in-time copy. Never an alias of live counters. */
  snapshot() {
    const observed = { ...this.observed }
    const reserved = { ...this.reservedValue }
    const charged = {
      inputTokens: observed.inputTokens + reserved.inputTokens,
      outputTokens: observed.outputTokens + reserved.outputTokens,
    }
    const remaining = {
      requests: Math.max(0, this.limitsValue.requests - this.attempts),
      inputTokens: Math.max(0, this.limitsValue.inputTokens - charged.inputTokens),
      outputTokens: Math.max(0, this.limitsValue.outputTokens - charged.outputTokens),
      wallClockMs: Math.max(0, this.limitsValue.wallClockMs - this.elapsedMs()),
    }
    return Object.freeze({
      schemaVersion: BUDGET_SCHEMA_VERSION,
      limits: Object.freeze({ ...this.limitsValue }),
      used: Object.freeze({
        requests: this.attempts,
        attempts: this.attempts,
        inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens,
        cacheReadTokens: observed.cacheReadTokens,
        cacheWriteTokens: observed.cacheWriteTokens,
        unknownUsage: this.unknownUsageRequests,
        unknownUsageRequests: this.unknownUsageRequests,
        partialUsageRequests: this.partialUsageRequests,
        retries: this.retryCount,
      }),
      observed: Object.freeze(observed),
      reserved: Object.freeze(reserved),
      charged: Object.freeze(charged),
      remaining: Object.freeze(remaining),
      unresolvedAttempts: this.outstanding.length,
      unknownUsageRequests: this.unknownUsageRequests,
      partialUsageRequests: this.partialUsageRequests,
      refusals: this.refusalCount,
      elapsedMs: this.elapsedMs(),
    })
  }
}

/** Subtract two immutable snapshots, per field. Used for one case's cost. */
export function snapshotDelta(before, after) {
  const difference = (left, right) => right - left
  return {
    attempts: difference(before.used.attempts, after.used.attempts),
    inputTokens: difference(before.observed.inputTokens, after.observed.inputTokens),
    outputTokens: difference(before.observed.outputTokens, after.observed.outputTokens),
    cacheReadTokens: difference(before.observed.cacheReadTokens, after.observed.cacheReadTokens),
    cacheWriteTokens: difference(before.observed.cacheWriteTokens, after.observed.cacheWriteTokens),
    unknownUsageRequests: difference(before.unknownUsageRequests, after.unknownUsageRequests),
    partialUsageRequests: difference(before.partialUsageRequests, after.partialUsageRequests),
    unresolvedAttempts: after.unresolvedAttempts,
    elapsedMs: difference(before.elapsedMs, after.elapsedMs),
  }
}

/**
 * Validate the live run manifest and environment gate.
 *
 * Live execution requires ALL of:
 *   - `R33_LIVE=1`;
 *   - an explicit manifest with a resolved model/provider route;
 *   - positive request, input-token, output-token, and wall-clock limits;
 *   - a finite per-request output bound.
 *
 * A missing condition refuses the run. The message never contains a key.
 *
 * @returns {Promise<{ok:true, manifest:object}|{ok:false, reason:string}>}
 */
export async function loadLiveGate(manifestPath, env = process.env) {
  if (env.R33_LIVE !== '1') {
    return { ok: false, reason: 'R33_LIVE is not 1; refusing to spend provider credits' }
  }
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    return { ok: false, reason: 'no --manifest path was provided' }
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `manifest unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof manifest.model !== 'string' || manifest.model.length === 0) {
    return { ok: false, reason: 'manifest.model is required' }
  }
  const limits = manifest.limits
  if (limits === null || typeof limits !== 'object') return { ok: false, reason: 'manifest.limits is required' }
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'wallClockMs']) {
    if (!positiveInteger(limits[key])) {
      return { ok: false, reason: `manifest.limits.${key} must be a positive integer (0 does not mean unlimited)` }
    }
  }
  if (!positiveInteger(manifest.maxOutputTokens)) {
    return { ok: false, reason: 'manifest.maxOutputTokens must be a positive integer (the per-request bound)' }
  }
  const route = manifest.route
  if (route === null || typeof route !== 'object') return { ok: false, reason: 'manifest.route is required' }
  for (const key of ['baseUrlEnv', 'apiKeyEnv']) {
    if (typeof route[key] !== 'string' || route[key].length === 0) {
      return { ok: false, reason: `manifest.route.${key} is required (an environment variable NAME, never a secret)` }
    }
  }
  if (route.headers !== undefined) {
    if (route.headers === null || typeof route.headers !== 'object' || Array.isArray(route.headers)) {
      return { ok: false, reason: 'manifest.route.headers must be an object' }
    }
    for (const [name, value] of Object.entries(route.headers)) {
      if (typeof value !== 'string') {
        return { ok: false, reason: `manifest.route.headers.${name} must be a string` }
      }
      if (/^(authorization|proxy-authorization|api-key|x-api-key|x-auth-token|cookie)$/iu.test(name)) {
        return { ok: false, reason: `manifest.route.headers.${name} would place a credential in the manifest` }
      }
    }
  }
  if (manifest.arms !== undefined) {
    const allowed = new Set(['B1', 'S', 'O1', 'O2'])
    const arms = Array.isArray(manifest.arms) ? manifest.arms : String(manifest.arms).split(',')
    for (const arm of arms) {
      if (!allowed.has(String(arm).trim())) {
        return { ok: false, reason: `manifest.arms names unknown arm ${String(arm)}` }
      }
    }
  }
  return { ok: true, manifest }
}

/**
 * Compute the run status from case observations.
 *
 * Execution validity and task quality are separate facts:
 *
 *   valid rows           the evaluation produced a usable measurement
 *   behaviour.taskSuccess the agent solved the task
 *
 * A run where every measurement is valid but every task failed is
 * `executed-failed` (a negative research result), NOT a harness error. The
 * report carries `measurementValid` and `taskSuccessRate` beside the status so
 * no reader can confuse them.
 */
export function runStatus({ executed, cases, budgetExhausted, providerUnavailable, invalid }) {
  if (!executed) return 'not-executed'
  if (budgetExhausted) return 'budget-exhausted'
  if (providerUnavailable) return 'provider-unavailable'
  if (invalid || cases.length === 0) return 'invalid-benchmark'
  const valid = cases.filter(entry => entry.valid === true)
  if (valid.length === 0) return 'executed-failed'
  if (valid.length < cases.length) return 'executed-partial'
  return valid.some(entry => entry.behaviour?.taskSuccess === true)
    ? 'executed-success'
    : 'executed-failed'
}

/** The two facts a reader must not conflate, computed from the same rows. */
export function runQuality(cases) {
  const valid = cases.filter(entry => entry.valid === true)
  const success = valid.filter(entry => entry.behaviour?.taskSuccess === true)
  return {
    measurementValid: valid.length > 0,
    validCases: valid.length,
    invalidCases: cases.length - valid.length,
    taskSuccesses: success.length,
    taskSuccessRate: valid.length === 0 ? null : success.length / valid.length,
  }
}
