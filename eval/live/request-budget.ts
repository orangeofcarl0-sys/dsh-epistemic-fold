/**
 * A hard, PRE-REQUEST budget for one episode's provider traffic.
 *
 * ## Why a turn cap is not a request cap
 *
 * `EF_LHTB_MAX_TURNS` bounds the AGENT's turns. It does not bound provider requests:
 *
 *  * the fold's summarization goes through the same adapter and is invisible to the agent;
 *  * `OpenAiCompatibleAdapter` retries a 429 up to three times, and each retry is a real request;
 *  * so `MAX_TURNS=140` can mean well over 140 requests, and a cost authorization expressed in
 *    turns is not an authorization at all.
 *
 * ## Why the check is BEFORE the request
 *
 * A budget checked after the fact can only report the overspend. `admit()` runs immediately before
 * `fetch`, so an exhausted budget prevents the request rather than describing it, and it counts
 * the attempt even when the attempt fails.
 *
 * @module eval/live/request-budget
 */

/** A refusal, distinguishable from a provider failure by `code`. */
export class BudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED'

  constructor(readonly reason: string, readonly snapshot: BudgetSnapshot) {
    super(`episode budget exhausted (${reason}): ${JSON.stringify(snapshot)}`)
    this.name = 'BudgetExhaustedError'
  }
}

export interface BudgetLimits {
  /** Every HTTP ATTEMPT, including 429 retries. 0 disables the check. */
  readonly requests: number
  readonly promptTokens: number
  readonly outputTokens: number
  /** Wall clock from construction. 0 disables the check. */
  readonly wallClockMs: number
}

export interface BudgetSnapshot {
  readonly requests: number
  readonly promptTokens: number
  readonly outputTokens: number
  readonly elapsedMs: number
  readonly refusals: number
  readonly limit: BudgetLimits
}

export class RequestBudget {
  private requests = 0
  private promptTokens = 0
  private outputTokens = 0
  private refusals = 0
  private readonly startedAt = Date.now()

  constructor(readonly limit: BudgetLimits) {}

  /**
   * Admit one HTTP attempt, or refuse it.
   *
   * @throws BudgetExhaustedError when the attempt would exceed any limit. The attempt is NOT
   *   counted: a refused request never happened, and counting it would make the snapshot disagree
   *   with the provider's own request log.
   */
  admit(): void {
    const snapshot = this.snapshot()
    let reason: string | undefined
    if (this.limit.requests > 0 && this.requests >= this.limit.requests) reason = 'requests'
    else if (this.limit.promptTokens > 0 && this.promptTokens >= this.limit.promptTokens) reason = 'promptTokens'
    else if (this.limit.outputTokens > 0 && this.outputTokens >= this.limit.outputTokens) reason = 'outputTokens'
    else if (this.limit.wallClockMs > 0 && snapshot.elapsedMs >= this.limit.wallClockMs) reason = 'wallClock'
    if (reason === undefined) {
      this.requests += 1
      return
    }
    this.refusals += 1
    throw new BudgetExhaustedError(reason, snapshot)
  }

  /**
   * Record the usage one answered request reported.
   *
   * A response with NO usage leaves the totals alone. That is deliberate: treating a missing
   * measurement as zero is how a spent budget reports itself as unspent, which is the failure mode
   * this class exists to prevent. `requests` still moves, so the request limit stays sound.
   */
  record(usage: { readonly promptTokens?: number; readonly outputTokens?: number } | undefined): void {
    if (usage === undefined) return
    if (typeof usage.promptTokens === 'number' && Number.isFinite(usage.promptTokens)) {
      this.promptTokens += usage.promptTokens
    }
    if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
      this.outputTokens += usage.outputTokens
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      requests: this.requests,
      promptTokens: this.promptTokens,
      outputTokens: this.outputTokens,
      elapsedMs: Date.now() - this.startedAt,
      refusals: this.refusals,
      limit: this.limit,
    }
  }
}