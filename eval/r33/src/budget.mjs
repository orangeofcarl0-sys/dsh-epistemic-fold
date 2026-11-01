/**
 * One global budget for an entire R33 live run.
 *
 * R32's live entry had per-scenario request/time limits and no token limits at
 * all (`0` means "disabled" in the underlying budget), so four scenarios could
 * each spend the full allowance. R33's budget is created ONCE and shared by
 * every arm and every case. A retry is a request like any other.
 *
 * ## Honest states
 *
 * The run status is computed from observations, not from "main() returned":
 *
 *   not-executed        the live gate refused; nothing was spent
 *   executed-success    every case valid and at least one successful task
 *   executed-partial    some cases invalid, errored, or not run
 *   executed-failed     ran, but no case produced a usable result
 *   budget-exhausted    the run stopped because the global ledger refused
 *   provider-unavailable the route failed before any measurement
 *   invalid-benchmark   dataset/schema/checker failure, not a model result
 *
 * @module eval/r33/src/budget
 */

import { readFile } from 'node:fs/promises'

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
  constructor(reason) {
    super(`global R33 budget exhausted: ${reason}`)
    this.name = 'BudgetExhausted'
    this.reason = reason
  }
}

/**
 * The shared ledger.
 *
 * Token reservations are conservative: when a provider reports no usage, the
 * reservation is NOT refunded, because "unknown" must cost budget rather than
 * be free. That is the opposite of R32's zero-means-unlimited.
 */
export class BudgetLedger {
  constructor(limits) {
    this.limits = { ...limits }
    this.used = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unknownUsage: 0,
      retries: 0,
    }
    this.reserved = { requests: 0, inputTokens: 0, outputTokens: 0 }
    this.startedAt = Date.now()
  }

  /** Wall-clock used, including time spent waiting on providers. */
  elapsedMs() {
    return Date.now() - this.startedAt
  }

  /** Whether a new request of the given estimated size can be admitted. */
  canReserve(estimate) {
    if (this.used.requests + this.reserved.requests >= this.limits.requests) return 'requests'
    if (this.used.inputTokens + this.reserved.inputTokens + estimate.inputTokens > this.limits.inputTokens) {
      return 'inputTokens'
    }
    if (this.used.outputTokens + this.reserved.outputTokens + estimate.outputTokens > this.limits.outputTokens) {
      return 'outputTokens'
    }
    if (this.elapsedMs() > this.limits.wallClockMs) return 'wallClockMs'
    return undefined
  }

  /** Reserve one request before it is sent. Throws when the budget is spent. */
  reserve(estimate) {
    const reason = this.canReserve(estimate)
    if (reason !== undefined) throw new BudgetExhausted(reason)
    this.reserved.requests += 1
    this.reserved.inputTokens += estimate.inputTokens
    this.reserved.outputTokens += estimate.outputTokens
  }

  /** Convert a reservation into recorded usage; unknown usage keeps the charge. */
  record({ usage, retry = false, reservation }) {
    this.reserved.requests = Math.max(0, this.reserved.requests - 1)
    this.reserved.inputTokens = Math.max(0, this.reserved.inputTokens - reservation.inputTokens)
    this.reserved.outputTokens = Math.max(0, this.reserved.outputTokens - reservation.outputTokens)
    this.used.requests += 1
    if (retry) this.used.retries += 1
    if (usage === undefined) {
      this.used.unknownUsage += 1
      this.used.inputTokens += reservation.inputTokens
      this.used.outputTokens += reservation.outputTokens
      return
    }
    this.used.inputTokens += usage.inputTokens ?? 0
    this.used.outputTokens += usage.outputTokens ?? 0
    this.used.cacheReadTokens += usage.cacheReadTokens ?? 0
    this.used.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  }

  snapshot() {
    const remaining = {
      requests: Math.max(0, this.limits.requests - this.used.requests),
      inputTokens: Math.max(0, this.limits.inputTokens - this.used.inputTokens),
      outputTokens: Math.max(0, this.limits.outputTokens - this.used.outputTokens),
      wallClockMs: Math.max(0, this.limits.wallClockMs - this.elapsedMs()),
    }
    return { limits: this.limits, used: this.used, remaining }
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Validate the live run manifest and environment gate.
 *
 * Live execution requires ALL of:
 *   - `R33_LIVE=1`;
 *   - an explicit manifest with a resolved model/provider route;
 *   - positive request, input-token, and output-token limits;
 *   - a positive wall-clock limit.
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
  return { ok: true, manifest }
}

/** Compute the run status from case observations. */
export function runStatus({ executed, cases, budgetExhausted, providerUnavailable, invalid }) {
  if (!executed) return 'not-executed'
  if (budgetExhausted) return 'budget-exhausted'
  if (providerUnavailable) return 'provider-unavailable'
  if (invalid || cases.length === 0) return 'invalid-benchmark'
  const valid = cases.filter(entry => entry.valid !== false && entry.status !== 'invalid')
  if (valid.length === 0) return 'executed-failed'
  if (valid.length < cases.length) return 'executed-partial'
  return cases.some(entry => entry.taskSuccess === true) ? 'executed-success' : 'executed-failed'
}
