/**
 * Bounded retry for a summarization the provider truncated.
 *
 * ## The failure this exists for
 *
 * `max_tokens` caps a reasoning model's REASONING and its CONTENT together, so a
 * budget sized for a non-reasoning model is partly spent before the answer starts.
 * Measured on `step-5-preview-free` summarising a 127K-token transcript:
 *
 *     cap= 2048  finish=length  reasoning=1467  contentLen= 1539
 *     cap= 4096  finish=length  reasoning=3920  contentLen=  666
 *     cap= 8192  finish=length  reasoning=1639  contentLen=19131
 *     cap=32768  finish=stop    reasoning=1928  contentLen= 3631
 *
 * At 8192 the model wrote nineteen thousand characters and still hit the cap. Basic
 * reports that as `summarization truncated at the token cap (incomplete checkpoint)`
 * and fails the fold CLOSED, which is correct — a half-written checkpoint must not
 * land as if it were complete — but it is not the only correct response. The call is
 * recoverable, so the fold should be retried before it is abandoned.
 *
 * ## Why the retry ESCALATES rather than repeating
 *
 * A repeat at the same budget only helps when the overrun was a coin flip. The
 * evidence says it is a deficit: the same input truncated at every cap from 2048 to
 * 16384 while the model wrote more than eight thousand tokens of summary. Repeating
 * reproduces the same constraint, so each retry raises the budget instead. The
 * alternative — accept the partial text — is rejected: the truncation can cut any
 * section, and a checkpoint that silently omits `Critical Context` is worse than a
 * fold that failed loudly.
 *
 * The provider accepts a raised budget rather than rejecting it (probed HTTP 200 at
 * `max_tokens` 65536, 131072 and 262144), so escalation cannot turn a retryable
 * truncation into an HTTP failure.
 *
 * ## Scope
 *
 * This is a property of the PROVIDER/MODEL interaction, not of a compaction strategy,
 * so every arm of a comparison gets it: applying it to one arm only would credit that
 * arm with a provider artefact. It changes nothing on the success path — attempt zero
 * is the unmodified call.
 *
 * @module src/summary-retry
 */

/** Attempts beyond the first that one truncated summarization is given. */
const DEFAULT_EXTRA_ATTEMPTS = 2

/** Ceiling on an escalated budget, so escalation cannot run away. */
const DEFAULT_CEILING = 131_072

/** Budget and attempt count for one summarization's retry schedule. */
export interface SummaryRetryPolicy {
  /** Retries allowed after the first attempt; `0` disables retrying entirely. */
  readonly extraAttempts: number
  /** Largest budget any attempt may use. */
  readonly ceiling: number
}

/** Lifetime retry telemetry, so \"no truncation happened\" is distinguishable from \"retries saved it\". */
export interface SummaryRetryStats {
  /** Every summarization attempt made, retries included. */
  attempts: number
  /** Attempts made because an earlier attempt truncated. */
  retries: number
  /** Retries whose budget was raised above the first attempt's. */
  escalations: number
  /** Summarizations that truncated on EVERY attempt and therefore still failed the fold. */
  exhausted: number
  /** The most recent truncation message, or `null` when none has been seen. */
  lastError: string | null
}

/** Mutable process-lifetime totals, mirroring the engine's other monotonic counters. */
export const summaryRetryStats: SummaryRetryStats = {
  attempts: 0,
  retries: 0,
  escalations: 0,
  exhausted: 0,
  lastError: null,
}

/**
 * Zero every counter.
 *
 * The totals are process-lifetime, matching the engine's, but a caller that reports
 * PER-EPISODE figures has to start each episode from zero: the LHTB bridge process is
 * long-lived, so a test and a second episode would otherwise inherit the first one's
 * retries and read a cleaner provider than it had.
 */
export function resetSummaryRetryStats(): void {
  summaryRetryStats.attempts = 0
  summaryRetryStats.retries = 0
  summaryRetryStats.escalations = 0
  summaryRetryStats.exhausted = 0
  summaryRetryStats.lastError = null
}

/**
 * Read the retry policy from the environment, falling back per field.
 *
 * Read at CALL time rather than module load so a test (or a long-lived process) can
 * change it between episodes, and so one malformed value cannot disable the others.
 * @returns the sanitized policy; a non-integer or negative attempt count and a
 * non-positive ceiling both fall back to their defaults rather than being honoured.
 */
export function summaryRetryPolicy(): SummaryRetryPolicy {
  const attempts = Number(process.env.EF_SUMMARY_RETRY_ATTEMPTS ?? DEFAULT_EXTRA_ATTEMPTS)
  const ceiling = Number(process.env.EF_SUMMARY_RETRY_CEILING ?? DEFAULT_CEILING)
  return {
    extraAttempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : DEFAULT_EXTRA_ATTEMPTS,
    ceiling: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : DEFAULT_CEILING,
  }
}

/**
 * The budget one attempt may spend.
 *
 * Attempts double: `base`, `2*base`, `4*base`. Never returns less than the base
 * budget — a ceiling below the configured budget must not silently shrink a call the
 * caller asked for — and never returns more than the ceiling.
 * @param baseTokens - the budget the first attempt uses.
 * @param attempt - zero-based attempt index; `0` is the first, unmodified call.
 * @param ceiling - largest budget any attempt may use.
 * @returns the budget for this attempt.
 */
export function summaryRetryBudget(baseTokens: number, attempt: number, ceiling: number): number {
  if (attempt <= 0) return baseTokens
  const escalated = baseTokens * 2 ** attempt
  return Math.max(baseTokens, Math.min(escalated, ceiling))
}

/**
 * Whether a summarization failure is the provider cutting the reply at the cap.
 *
 * The structured tag is checked first because Basic sets it deliberately; the message
 * match is the fallback for an error that crossed a process boundary (the LHTB bridge
 * does exactly that, and classifies on the message for the same reason).
 * @param error - the rejection from a summarization attempt.
 * @returns true when retrying with a larger budget is the right response.
 */
export function isTruncationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { code?: unknown }).code === 'MAX_TOKENS') return true
  const message = error instanceof Error ? error.message : ''
  return /truncated at the token cap/u.test(message)
}
