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

export interface TokenUsageLike {
  /** Uncached input, per DSH's disjoint counters. */
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  /** Accepted for callers that pass a raw provider record. */
  readonly promptTokens?: number
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
   * ## The field names are DSH's, not the provider's
   *
   * `mapUsage` returns disjoint counters -- `inputTokens` (which EXCLUDES cached input),
   * `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` -- and has no `promptTokens` at all.
   * Reading `usage.promptTokens` here counted nothing and left the token caps inert while they
   * looked implemented; the admission test that expects 100 tokens recorded 0 is what caught it.
   *
   * The prompt side is the SUM of its parts, deliberately: `inputTokens` alone would omit the
   * cached re-reads, which are the bulk of a long episode's prompt traffic and must not be free
   * merely because they are cheap.
   *
   * A response with NO usage leaves the totals alone. That is deliberate: treating a missing
   * measurement as zero is how a spent budget reports itself as unspent. `requests` still moves,
   * so the REQUEST limit stays sound even when usage is absent -- which is exactly the case the
   * token limits cannot cover, and the snapshot's job is to show that rather than hide it.
   */
  record(usage: TokenUsageLike | undefined, fallback?: TokenUsageLike): void {
    // A response with no usage still consumed SOMETHING, and the provider will bill for it.
    // Recording nothing is how 140 requests of unknown size look free: the request cap alone
    // would then bound nothing, because 140 x a full 131,072-token window is far past the
    // authorized usage. The caller supplies a CONSERVATIVE estimate instead.
    const effective = usage ?? fallback
    if (effective === undefined) return
    const prompt = (effective.inputTokens ?? 0)
      + (effective.cacheReadTokens ?? 0)
      + (effective.cacheWriteTokens ?? 0)
      + (effective.promptTokens ?? 0)
    if (Number.isFinite(prompt)) this.promptTokens += prompt
    if (typeof effective.outputTokens === 'number' && Number.isFinite(effective.outputTokens)) {
      this.outputTokens += effective.outputTokens
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
/**
 * Read one limit from the environment, refusing anything that would silently disable it.
 *
 * ## The hole this closes
 *
 * `Number(process.env.X ?? 0)` turns an EMPTY string into `0`, a typo into `NaN`, and a negative
 * number into itself -- and `admit()` tests `limit > 0`, so all three disable the check. An
 * experiment whose budget was switched off by a trailing space in a shell variable would spend
 * against a limit nobody could see. Unset still means disabled, because that is how an ordinary
 * lane keeps the old behaviour; SET BUT INVALID is an error.
 *
 * @param name - the variable name, so the message names the thing to fix.
 * @param env - the environment to read; injectable for tests.
 * @returns the limit, or 0 when the variable is unset.
 * @throws when the variable is set to anything that is not a non-negative integer.
 */
export function parseBudgetLimit(name: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]
  if (raw === undefined) return 0
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new Error(`${name} is set but empty; unset it to disable, or give a positive integer`)
  }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Build the limits for one episode, and enforce that the experiment armed them.
 *
 * @param env - the environment to read.
 * @returns the limits.
 * @throws when `EF_LHTB_BUDGET_REQUIRED` is truthy and any limit is still 0. A run that ASKS for
 *   budget enforcement must not be silently granted none.
 */
export function budgetLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const limits: BudgetLimits = {
    requests: parseBudgetLimit('EF_LHTB_BUDGET_REQUESTS', env),
    promptTokens: parseBudgetLimit('EF_LHTB_BUDGET_PROMPT_TOKENS', env),
    outputTokens: parseBudgetLimit('EF_LHTB_BUDGET_OUTPUT_TOKENS', env),
    wallClockMs: parseBudgetLimit('EF_LHTB_BUDGET_WALL_MS', env),
  }
  if (env['EF_LHTB_BUDGET_REQUIRED'] === '1') {
    const off = (Object.entries(limits) as [string, number][]).filter(([, value]) => value === 0)
    if (off.length > 0) {
      throw new Error(
        `EF_LHTB_BUDGET_REQUIRED=1 but these limits are disabled: ${off.map(([k]) => k).join(', ')}`,
      )
    }
  }
  return limits
}