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

/**
 * The output a single request is RESERVED at when its true cost is unknown.
 *
 * Derived from the code, not guessed: `EF_LHTB_REPLY_MAX_TOKENS_CEILING` defaults to **131,072**,
 * and `escalate_reply_budget()` may raise a reply up to that ceiling, so a LEGITIMATE main-model
 * request can use far more than the summarization's 32,768. Reserving the smaller figure would
 * under-charge exactly the requests this reserve exists to cover.
 */
export const DEFAULT_OUTPUT_RESERVE = 131_072_768

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
  readonly observedPromptTokens: number
  readonly observedOutputTokens: number
  readonly reservedPromptTokens: number
  readonly reservedOutputTokens: number
  readonly unknownUsageRequests: number
  readonly partialUsageRequests: number
  readonly elapsedMs: number
  readonly refusals: number
  readonly limit: BudgetLimits
}

export class RequestBudget {
  private requests = 0
  private refusals = 0
  private readonly startedAt = Date.now()

  /**
   * Conservative per-request reserves, charged when a request is ADMITTED.
   *
   * ## Why the reserve happens at admission and not on success
   *
   * `record()` used to run only after a 200 whose JSON parsed. So a request that was SENT and
   * then failed -- HTTP 5xx, a transport error, an abort, a parse failure, a 429 whose retries
   * ran out -- charged nothing, while the provider may well have processed and billed it. A
   * partial usage record was worse: `mapUsage` fills the absent fields with 0, so the object
   * existed and the conservative fallback did not apply, and the request was under-charged.
   *
   * Reserving at admission covers every one of those cases without touching a single failure
   * path, because the charge happens before the request rather than after its outcome.
   *
   * The reserve is not a measurement and is never reported as one: `snapshot()` keeps
   * `observed` (provider-reported), `reserved` (conservative, for requests whose true cost is
   * unknown) and `unknownUsageRequests` apart.
   */
  private readonly reserve: { readonly promptTokens: number; readonly outputTokens: number }
  private reservedPrompt = 0
  private reservedOutput = 0
  private observedPrompt = 0
  private observedOutput = 0
  private unknownUsageRequests = 0
  private partialUsageRequests = 0
  /** The most recent admission's reserve, settled by the next `record`. */
  private outstanding: { promptTokens: number; outputTokens: number } | undefined

  constructor(
    readonly limit: BudgetLimits,
    reserve: { readonly promptTokens: number; readonly outputTokens: number } = {
      promptTokens: 0,
      outputTokens: 0,
    },
  ) {
    this.reserve = reserve
  }

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
    else if (this.limit.promptTokens > 0 && this.consumedPrompt() >= this.limit.promptTokens) reason = 'promptTokens'
    else if (this.limit.outputTokens > 0 && this.consumedOutput() >= this.limit.outputTokens) reason = 'outputTokens'
    else if (this.limit.wallClockMs > 0 && snapshot.elapsedMs >= this.limit.wallClockMs) reason = 'wallClock'
    if (reason === undefined) {
      this.requests += 1
      this.reservedPrompt += this.reserve.promptTokens
      this.reservedOutput += this.reserve.outputTokens
      this.outstanding = { ...this.reserve }
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
   * The admission RESERVE for this request is settled first: it was charged when the request was
   * admitted, and the measurement replaces it rather than adding to it. A request that never
   * reaches `record` -- 5xx, transport error, abort, unparseable body, exhausted 429 retries --
   * keeps its reserve, which is the conservative treatment of a request that may have been
   * processed and billed.
   *
   * `usage === undefined` (no usage at all) settles with the caller's fallback. A PARTIAL usage
   * record is settled with what it says, and is counted in `partialUsageRequests`: `mapUsage`
   * fills absent fields with 0, so the object exists and a `undefined` test cannot see it.
   */
  record(
    usage: TokenUsageLike | undefined,
    fallback?: TokenUsageLike,
    reported: { readonly prompt: boolean; readonly output: boolean } = { prompt: true, output: true },
  ): void {
    // ## Settlement is PER DIMENSION, and an unreported dimension keeps its reserve
    //
    // Settling the whole reserve and then adding the measurement RELEASES the reserve of any
    // dimension the provider did not report -- and `mapUsage` reports 0 for an absent field, so
    // `{prompt_tokens: 12000}` used to free the entire output reserve as if the reply had been
    // free. A dimension settles only when the caller says it was RELIABLY reported; otherwise the
    // conservative reserve stands, which is the whole point of having one.
    const effective = usage ?? fallback
    if (usage === undefined) this.unknownUsageRequests += 1
    if (!reported.prompt || !reported.output) this.partialUsageRequests += 1
    if (effective === undefined) return
    if (this.outstanding !== undefined) {
      if (reported.prompt) this.reservedPrompt -= this.outstanding.promptTokens
      if (reported.output) this.reservedOutput -= this.outstanding.outputTokens
      this.outstanding = undefined
    }
    if (reported.prompt) {
      const prompt = (effective.inputTokens ?? 0)
        + (effective.cacheReadTokens ?? 0)
        + (effective.cacheWriteTokens ?? 0)
        + (effective.promptTokens ?? 0)
      if (Number.isFinite(prompt)) this.observedPrompt += prompt
    }
    if (reported.output && typeof effective.outputTokens === 'number' && Number.isFinite(effective.outputTokens)) {
      this.observedOutput += effective.outputTokens
    }
  }
  /** Prompt tokens charged: measured plus conservatively reserved. */
  consumedPrompt(): number {
    return this.observedPrompt + this.reservedPrompt
  }

  /** Output tokens charged: measured plus conservatively reserved. */
  consumedOutput(): number {
    return this.observedOutput + this.reservedOutput
  }

  snapshot(): BudgetSnapshot {
    return {
      requests: this.requests,
      // `promptTokens`/`outputTokens` are the CHARGED totals -- measured plus reserved -- because
      // those are what admission compares against. The split is published beside them so a
      // report can never present a reserve as a provider measurement.
      promptTokens: this.consumedPrompt(),
      outputTokens: this.consumedOutput(),
      observedPromptTokens: this.observedPrompt,
      observedOutputTokens: this.observedOutput,
      reservedPromptTokens: this.reservedPrompt,
      reservedOutputTokens: this.reservedOutput,
      unknownUsageRequests: this.unknownUsageRequests,
      partialUsageRequests: this.partialUsageRequests,
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