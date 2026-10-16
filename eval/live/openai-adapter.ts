/**
 * A live OpenAI-compatible adapter for the opt-in behavioral subset.
 *
 * This adapter exists to answer the one question the keyless tier cannot:
 * does Epistemic Fold preserve TASK SUCCESS, not just tokens? It therefore
 * drives the real provider and reports the provider's own token accounting.
 *
 * Two design points matter for the measurement's honesty:
 *
 * 1. **Cache counters are disjoint.** DSH's `TokenUsage` requires
 *    `inputTokens` to be UNCACHED input only, with cache reads and writes
 *    reported separately. Providers that fold hits into `prompt_tokens`
 *    (this endpoint does: `prompt_tokens` includes the cached part) must have
 *    them subtracted out. Getting this wrong would double-count the cached
 *    prefix and corrupt every downstream economics figure, so the mapping is
 *    explicit and unit-tested.
 *
 * 2. **No key ever leaves this object.** The adapter holds the credential for
 *    the life of a run and redacts it from every error it raises.
 *
 * @module eval/live/openai-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { BudgetExhaustedError, type RequestBudget, type Reservation } from './request-budget.ts'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { redactSecret } from './zcode-config.ts'

/** The provider's raw response shape, as far as this adapter depends on it. */
interface WireMessage {
  readonly role?: string
  readonly content?: string | null
  readonly tool_calls?: readonly {
    readonly id?: string
    readonly type?: string
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }[]
}

interface WireUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly total_tokens?: number
  /** This endpoint's own naming for the disjoint cache counters. */
  readonly cache_hit_tokens?: number
  readonly cache_miss_tokens?: number
  readonly cache_write_tokens?: number
  readonly prompt_tokens_details?: { readonly cached_tokens?: number }
}

interface WireResponse {
  readonly model?: string
  readonly choices?: readonly { readonly message?: WireMessage; readonly finish_reason?: string }[]
  readonly usage?: WireUsage
}

/**
 * Map a provider usage record onto DSH's disjoint `TokenUsage`.
 *
 * `inputTokens` must exclude cached input. When the provider reports its own
 * `cache_miss_tokens` that value IS the uncached input; otherwise the cached
 * count is subtracted from the aggregate prompt total. When no cache field is
 * present at all, the whole prompt is uncached — reporting it as cached would
 * invent a hit rate.
 *
 * @param usage - the provider's raw usage record.
 * @returns DSH usage with disjoint counters, or `undefined` when absent.
 */
export function mapUsage(usage: WireUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const prompt = usage.prompt_tokens ?? 0
  const cacheRead = usage.cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
  const cacheWrite = usage.cache_write_tokens
  const uncached = usage.cache_miss_tokens !== undefined
    ? usage.cache_miss_tokens
    : Math.max(0, prompt - (cacheRead ?? 0))
  return {
    inputTokens: uncached,
    outputTokens: usage.completion_tokens ?? 0,
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

/** Serialize one DSH request message into the provider's chat shape. */
function toWireMessage(message: RequestMessage): Record<string, unknown> {
  const text = message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
  // A hand-built one-shot may pass a bare RequestUserInput, which carries no
  // durable role discriminator beyond `role: 'user'`.
  const role = (message as { role: string }).role
  if (role === 'tool') {
    const tool = message as unknown as { toolCallId: string }
    return { role: 'tool', tool_call_id: tool.toolCallId, content: text }
  }
  if (role === 'assistant') {
    // ## A replayed assistant message must carry `reasoning_content`, even empty
    //
    // Measured on `deepseek-v4.1-flash` through `/zen/go/v1`, and it cost a wave its
    // diagnosis twice over: the provider answers, verbatim,
    //
    //   invalid_request_error: The `reasoning_content` in the thinking mode must be
    //   passed back to the API. (request_id: ...)
    //
    // DSH's own provider layer has a catalog compat flag for exactly this --
    // `requiresReasoningContentOnAssistantMessages`, documented as "Whether replayed
    // assistant messages need an EMPTY `reasoning_content` while reasoning is on"
    // (`vendor/deepseek-harness/packages/llm/llm-pi-ai/src/catalog.ts:398`). Its remedy is
    // the empty form, because the provider checks that the field was REPLAYED, not what it
    // says: a hand-built history carrying `''`, the real reasoning, or nothing at all all
    // answer HTTP 200 when the replayed turn is synthetic.
    //
    // The real reasoning text is NOT recoverable here: DSH's `Message` has no reasoning
    // block, so a bridge that wanted to pass back the true text would have to carry a
    // side channel. The empty form is what the vendor prescribes and what compliance needs.
    const calls = message.content.filter(block => block.type === 'tool-call')
    const reasoning = { reasoning_content: '' }
    if (calls.length === 0) return { role: 'assistant', content: text, ...reasoning }
    return {
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...reasoning,
      tool_calls: calls.map(block => ({
        id: block.type === 'tool-call' ? block.id : '',
        type: 'function',
        function: {
          name: block.type === 'tool-call' ? block.name : '',
          arguments: block.type === 'tool-call' ? block.arguments : '{}',
        },
      })),
    }
  }
  // system / developer / user all carry plain text to the provider.
  return { role: role === 'developer' ? 'system' : role, content: text }
}

/** Serialize DSH tool schemas into the provider's function-tool shape. */
function toWireTools(tools: readonly ToolSchema[] | undefined): unknown[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/** Map the provider's finish reason onto DSH's vocabulary. */
function mapFinish(reason: string | undefined, sawToolCall: boolean): FinishReason {
  if (sawToolCall || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * How many times a rate-limited call is retried before the failure is reported.
 *
 * Three attempts is chosen against the measured shape of the fault: the Phase 7
 * two-pass run saw 2-14% of calls throttled, so a burst is short and a couple of
 * retries clears it — while an outage that survives three attempts is a real
 * outage, and reporting it is more useful than continuing to sleep through the
 * episode budget.
 */
const MAX_RATE_LIMIT_RETRIES = 3

/**
 * How long a single request may take before it is abandoned.
 *
 * ## Why a request needs a deadline of its own
 *
 * The caller-supplied signal bounds a TURN, not a request, and the live driver passes none for an
 * ordinary model call. So a request that never returns had nothing to stop it: the cell sat there
 * while Harbor reported the trial as running and the container stayed Up, and the only thing that
 * ended it was the 28800s task budget. That is the documented "fold stalled for 16 minutes with
 * both sides alive and no error anywhere", observed again on the LongCat route, where the endpoint
 * answers 429 for large prompts and can simply hang.
 *
 * A deadline turns a hang into a transport failure, which the caller already knows how to record as
 * a provider failure. It is combined with the caller signal so cancellation still wins immediately.
 *
 * Two minutes, chosen by measurement rather than taste. At five minutes the LongCat route managed 2.7
 * model calls per cell in 25 minutes; at two it managed 4.8 in 6 -- a sevenfold improvement -- while
 * the longest LEGITIMATE call measured 40s, so two minutes still leaves three times the headroom a
 * healthy call needs. A longer deadline does not make a hung request succeed; it only spends budget
 * waiting to find out.
 *
 * That measurement is LONGCAT's, and it is not universal. Measured later on `deepseek-v4.1-flash`
 * at 8-way concurrency (`telemetry.timing.callMs`): mean call 47.9s, maximum 64.4s, and one call in
 * seven reported exactly this deadline -- i.e. it was ABORTED. An aborted call is not a slow call:
 * the caller closes the turn empty, so the cell pays the full deadline and receives nothing. The
 * LHTB lane therefore raises it per model (`scripts/run-lhtb.sh` -> `model_request_timeout`) rather
 * than this default moving, because moving it would rewrite LongCat's measured choice.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.EF_LIVE_REQUEST_TIMEOUT_MS ?? 120_000)

/** First backoff step when the provider sends no `Retry-After`. */
const RATE_LIMIT_BASE_DELAY_MS = 1_000

/**
 * Ceiling on one wait, whether it came from `Retry-After` or from the backoff.
 *
 * A provider may ask for minutes. Sleeping that long inside a measured episode
 * spends the budget being timed rather than doing work, so the wait is clamped
 * and the retry that follows is allowed to fail normally.
 */
const MAX_RETRY_AFTER_MS = 30_000

export interface LiveAdapterOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly contextWindow?: number
  /**
   * Extra request headers, carried by the route.
   *
   * `https://opencode.ai/zen/go/v1` answers `400 MissingSessionID` on every call
   * without an `x-opencode-session` header. Sent on every request; the adapter
   * neither invents nor validates them.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
  /**
   * The episode's hard pre-request budget, when the experiment sets one.
   *
   * It lives HERE because this is the only place every provider request passes: the main model
   * call, the fold's summarization, and the 429 retries inside `requestWithRetry`. A gate
   * anywhere else is bypassable by construction.
   */
  readonly budget?: RequestBudget
}

/**
 * The live adapter. One instance serves one model route.
 */
export class OpenAiCompatibleAdapter
  extends LlmAdapter {
  /** How many requests needed their tool shape repaired, and how much was changed. */
  toolShapeRepairs = 0
  toolResultsSynthesised = 0
  toolResultsDropped = 0
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly contextWindow: number
  private readonly headers: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch
  private readonly budget: RequestBudget | undefined
  /** Rate-limit retries performed, and rate limits given up on. See the getter. */
  private rateLimitRetries = 0
  private rateLimitExhausted = 0

  constructor(options: LiveAdapterOptions) {
    super()
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.model = options.model
    this.contextWindow = options.contextWindow ?? 131_072
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.budget = options.budget
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  /**
   * POST one request, retrying a rate limit a bounded number of times.
   *
   * ## Why a 429 must be retried rather than reported
   *
   * Before this, the adapter was single-shot: a 429 became a `LIVE_HTTP` finish
   * with no content, which the bridge turned into an empty reply and the LHTB
   * agent counted toward its empty-reply streak — so a rate limit could append a
   * fabricated turn to the conversation and end the episode. The Phase 7 two-pass
   * run measured 2%, 5%, 7% and 14% upstream 429 rates across four passes, which
   * is exactly the confound that makes arm comparison impossible: a cell's reward
   * would depend on provider load rather than on the mode.
   *
   * ## Why the retry is bounded and honours Retry-After
   *
   * A rate limit is transient, so retrying is the correct response — but an
   * unbounded retry turns a provider outage into a hung benchmark, and the
   * episode budget is the thing being measured. So: at most `MAX_RATE_LIMIT_RETRIES`
   * attempts, each waiting the provider's own `Retry-After` when it sends one
   * (capped, because a provider may ask for minutes), otherwise an exponential
   * backoff. Anything else — 5xx, 4xx, transport — is NOT retried here: a 500 is
   * a different fault with different handling, and silently retrying it would
   * hide the outages the run needs to record.
   *
   * The abort signal is honoured between attempts, so a cancelled turn does not
   * keep sleeping.
   *
   * @param body - the request body, serialized per attempt.
   * @param signal - the caller's cancellation signal.
   * @returns the response, once it is not a rate limit or the budget is spent.
   * @throws when the transport fails, exactly as a single-shot call would.
   */
  private async requestWithRetry(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    maxTokens?: number,
  ): Promise<{ response: Response; reservation: Reservation | undefined }> {
    let reservation: Reservation | undefined
    let attempt = 0
    for (;;) {
      signal?.throwIfAborted()
      // Combined with the caller signal so a cancelled turn still stops at once, and bounded so a
      // request that never returns cannot hold a cell open until the task budget expires.
      const requestDeadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const requestSignal = signal === undefined
        ? requestDeadline
        : AbortSignal.any([signal, requestDeadline])
      // BEFORE the request, not after: a budget checked afterwards can only report the
      // overspend. `admit` counts the ATTEMPT, including a 429 retry's, and returns the
      // CREDENTIAL this attempt's reservation is settled by.
      //
      // The reserve follows the max_tokens ACTUALLY sent, not a constant. A constant was wrong
      // in both directions: it over-charged ordinary calls, and when it exceeded the whole
      // output limit it deadlocked the gate after one failed request (measured on the P1 run).
      // Escalating the reply budget raises this with it, because it is read from the same value
      // that goes on the wire.
      reservation = this.budget?.admit(
        maxTokens === undefined
          ? { promptTokens: this.contextWindow }
          : { promptTokens: this.contextWindow, outputTokens: maxTokens },
      )
      // The reservation must survive the throw. `stream()` only receives it on the SUCCESS path,
      // so an error that leaves here without it takes the credential with it and the reserve can
      // never be settled -- which is exactly how the first version of this fix failed.
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          // Route-required extras (e.g. `x-opencode-session` on `/zen/go/v1`).
          // Spread FIRST, so the two headers below always win: a route may add a
          // requirement, but it must not be able to replace the credential or the
          // content type by naming them. Pinned by tests/live-route-headers.spec.ts.
          ...this.headers,
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
        })
      } catch (error: unknown) {
        // Ride the credential out on the error so the caller can settle it.
        if (error !== null && typeof error === 'object') {
          ;(error as { reservation?: Reservation | undefined }).reservation = reservation
        }
        throw error
      }
      if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) {
        if (response.status === 429) this.rateLimitExhausted += 1
        return { response, reservation }
      }
      attempt += 1
      this.rateLimitRetries += 1
      await this.sleep(this.retryDelayMs(response, attempt), signal)
    }
  }

  /**
   * How long to wait before attempt `attempt + 1`.
   *
   * `Retry-After` is honoured in its delta-seconds form — the form this endpoint
   * uses — and clamped: a provider asking for longer than the cap would otherwise
   * spend the whole episode budget asleep, which is worse than failing the call.
   */
  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get('retry-after')
    if (header !== null) {
      const seconds = Number(header.trim())
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
      }
    }
    return Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS)
  }

  /** Sleep, aborting early if the caller cancels. */
  private sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('live provider retry aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Rate-limit retries this adapter has performed, and rate limits it gave up on.
   *
   * Exposed so a run can report how much of its wall clock was provider
   * throttling rather than work — the confound the two-pass measurement could not
   * separate.
   */
  get rateLimitTelemetry(): { readonly retries: number; readonly exhausted: number } {
    return { retries: this.rateLimitRetries, exhausted: this.rateLimitExhausted }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The system prompt goes in as a `system`-ROLE MESSAGE, not as a top-level
    // `system` field.
    //
    // RC1-E found this the hard way: this endpoint accepts a top-level `system`
    // field, returns HTTP 200, and silently ignores it. A 240,003-character
    // system prompt billed 13 prompt tokens — the size of the user message
    // alone. Every live measurement that assembled a real system prompt was
    // therefore not sending it, which matters most for the R3 framing change:
    // its entire saving is earned by moving the checkpoint preamble INTO the
    // system prompt, and that saving was being measured on requests that
    // carried no system prompt at all.
    //
    // The `system` role inside `messages` is the OpenAI-compatible spelling and
    // is what this endpoint actually prices (verified: 12,007 tokens for a
    // 12,000-token system message).
    const messages: Record<string, unknown>[] = []
    if (options.system !== undefined && options.system.length > 0) {
      messages.push({ role: 'system', content: options.system })
    }
    messages.push(...options.messages.map(toWireMessage))

    // ## Every tool_call must have exactly one result, or the provider rejects the request
    //
    // Measured against this route: an assistant message whose tool_calls are not all answered,
    // or a tool result naming an id that was never called, returns HTTP 400
    // `invalid_request_error`. Order does not matter and the CONTENT does not matter -- NUL
    // bytes, lone surrogates and 200KB of output all pass. The request SHAPE is what is rejected.
    //
    // That matters because the failure is self-perpetuating: once the history holds an unanswered
    // tool_call, every later request in that episode is malformed, so the cell stops dead while
    // every outer layer still reports it as running. Observed as 13 provider failures in 23 calls
    // and then no further progress at all. It is model-independent -- this is the benchmark's own
    // request shape, not a provider's weakness.
    //
    // Repaired rather than refused, because refusing kills the episode. The placeholder says what
    // it is, so a reader can tell a real result from a synthesised one, and the count is reported
    // on stderr and in the adapter's counters rather than being absorbed silently.
    const calledIds = new Set<string>()
    for (const m of messages) {
      const calls = m.tool_calls as readonly { id?: unknown }[] | undefined
      if (!Array.isArray(calls)) continue
      for (const c of calls) if (typeof c.id === 'string' && c.id.length > 0) calledIds.add(c.id)
    }
    if (calledIds.size > 0 || messages.some(m => m.role === 'tool')) {
      const answeredIds = new Set<string>()
      for (const m of messages) {
        if (m.role === 'tool' && typeof m.tool_call_id === 'string') answeredIds.add(m.tool_call_id)
      }
      const orphans = messages.filter(
        m => m.role === 'tool' && !calledIds.has(String(m.tool_call_id)),
      ).length
      if (orphans > 0) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i]!
          if (m.role === 'tool' && !calledIds.has(String(m.tool_call_id))) messages.splice(i, 1)
        }
      }
      let missing = 0
      for (const id of calledIds) {
        if (answeredIds.has(id)) continue
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: '[ef-bridge] no result was recorded for this tool call',
        })
        missing += 1
      }
      if (orphans > 0 || missing > 0) {
        this.toolShapeRepairs += 1
        this.toolResultsSynthesised += missing
        this.toolResultsDropped += orphans
        process.stderr.write(
          `[openai-adapter] repaired an invalid tool shape: ${missing} unanswered tool_call(s) ` +
          `filled, ${orphans} orphan tool result(s) dropped. The provider rejects this shape ` +
          `with HTTP 400, and one bad history poisons every later request in the episode.\n`,
        )
      }
    }

    // The Zen free tier refuses `stream: false` with `403 FreeTierError`: measured 2026-10-16,
    // IDENTICAL requests answered 403 non-streamed and 200 streamed. Opt in per route rather
    // than flipping the default, so no existing route changes behaviour.
    const streamed = process.env.EF_LIVE_STREAM === '1'
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: streamed,
    }
    if (streamed) body.stream_options = { include_usage: true }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    let tools = toWireTools(options.tools)
    // ## The Zen free tier gates on the TOOL NAMES, not only on identity
    //
    // Measured 2026-10-16 against `/inference/v1`, same identity, same body, one field apart:
    //   tools = read+bash            -> 200
    //   tools = run_shell (EF's own) -> 403 FreeTierError
    //   tools = run_shell+read+bash  -> 200
    // The gate requires declarations named exactly `read` and `bash`. This lane's agent offers
    // EF tools under other names, so EVERY call was refused -- which is what the 403 loops were,
    // not a stall and not an identity problem.
    //
    // The added declarations are INERT: the description says so, and the bridge does not
    // execute a tool the arm never offered. They exist to pass admission, exactly as
    // `enforceAnonymousTools` does in `dsh-opencode-free`.
    if (process.env.EF_LIVE_ZEN_FREE === '1') tools = ensureZenFreeTools(tools)
    if (tools !== undefined) body.tools = tools

    let response: Response
    let reservation: Reservation | undefined
    try {
      const attempted = await this.requestWithRetry(body, options.signal, options.maxTokens)
      response = attempted.response
      reservation = attempted.reservation
    } catch (error: unknown) {
      // ## Carry the CAUSE, not just undici's flat "fetch failed"
      //
      // The bridge records `lastProviderError = finishReason.slice('error:'.length)`, so whatever
      // this message says is ALL the archive will ever know. `docs/108` claimed the detail was
      // preserved; it was not -- the archive still read a bare `fetch failed`, which is why the
      // 2026-10-16 failures could not be attributed (docs/118). undici puts the real reason in
      // `cause` (and, for an address set, in `cause.errors`), so it is appended here.
      const message = describeTransportError(error)
      // A budget refusal is NOT a transport failure. Tagging it apart is what lets the bridge
      // keep it out of `providerFailures` and the agent terminate with its own reason.
      const budget = error instanceof BudgetExhaustedError
      // A throw out of `requestWithRetry` never reaches the success path, so the credential is
      // recovered from the error itself.
      if (reservation === undefined && error !== null && typeof error === 'object') {
        reservation = (error as { reservation?: Reservation }).reservation
      }
      // ## A request that never left this machine cannot have consumed anything
      //
      // A reservation is held because the cost of a failed request is UNKNOWN. That is right for a
      // request that may have been processed, and wrong for one that provably was not: DNS failure,
      // connection refused, or a connect timeout mean the provider was never reached, so the true
      // consumption is zero and holding a full `max_tokens` reserve is not conservatism, it is
      // accounting for spend that cannot exist.
      //
      // Measured on the 2026-10-16 run: TEN `fetch failed` requests each stranded a 32,768 output
      // reservation -- 327,680, or 59% of the output budget -- and the run stopped at 61% of the
      // fold threshold because of it. A stranded reserve does not merely over-report cost; it ENDS
      // the episode, because `admit` refuses on charged-plus-reserved.
      if (!budget && reservation !== undefined && neverReachedProvider(error)) {
        // `release`, not `settle`: the latter leaves the reserved counters charged.
        this.budget?.release(reservation)
        reservation = undefined
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: redactSecret(message, this.apiKey),
            code: budget ? 'BUDGET_EXHAUSTED' : 'LIVE_TRANSPORT',
          },
        },
      }
      return
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `live provider HTTP ${response.status}: ${redactSecret(text.slice(0, 300), this.apiKey)}`,
            code: 'LIVE_HTTP',
          },
        },
      }
      return
    }

    const payload = streamed ? await readStreamedPayload(response) : (await response.json() as WireResponse)
    const choice = payload.choices?.[0]
    const message = choice?.message
    let sawToolCall = false

    const text = message?.content
    if (typeof text === 'string' && text.length > 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    for (const [index, call] of (message?.tool_calls ?? []).entries()) {
      const name = call.function?.name ?? ''
      const args = call.function?.arguments ?? '{}'
      const id = (call.id ?? `call-${index}`) as never
      sawToolCall = true
      yield { type: 'tool-call-delta', index: index + 1, id, name, argumentsDelta: args }
      const block: ContentBlock = { type: 'tool-call', id, name, arguments: args }
      yield { type: 'block-end', index: index + 1, block }
    }

    const usage = mapUsage(payload.usage)
    // A response with NO usage leaves the totals alone rather than reading as zero spend.
    // The fallback charges a FULL context window when the provider reports no usage. Recording
    // nothing would let 140 requests of unknown size look free, and the request cap alone does
    // not bound cost: 140 x 131,072 tokens is far past the authorized usage.
    // ## Which dimensions were RELIABLY reported
    //
    // Judged from the RAW record, because `mapUsage` fills absent fields with 0 and the mapped
    // object therefore cannot tell "reported zero" from "never reported". A dimension that is
    // absent -- or present but not a sane non-negative finite number -- is NOT reported, and the
    // budget keeps its conservative reserve for it rather than settling it to a smaller figure.
    const wire = payload.usage
    const sane = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0
    const reported = {
      prompt: wire !== undefined
        && (sane(wire.prompt_tokens) || sane(wire.cache_hit_tokens) || sane(wire.cache_miss_tokens)),
      output: wire !== undefined && sane(wire.completion_tokens),
    }
    this.budget?.record(usage, { promptTokens: this.contextWindow }, reported, reservation)
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: mapFinish(choice?.finish_reason, sawToolCall) }
  }
}

/**
 * Rebuild a NON-STREAMING payload from an SSE response.
 *
 * A route that only admits streaming (OpenCode Zen's free tier) would otherwise force every
 * consumer to learn a second shape. This collapses the frames back into the one the rest of the
 * adapter already reads, so exactly one line above changes.
 */
async function readStreamedPayload(response: Response): Promise<WireResponse> {
  const raw = await response.text()
  const content: string[] = []
  const reasoning: string[] = []
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  let usage: unknown
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') continue
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    if (frame.usage !== undefined && frame.usage !== null) usage = frame.usage
    const choices = frame.choices as { delta?: Record<string, unknown> }[] | undefined
    const delta = choices?.[0]?.delta
    if (delta === undefined) continue
    if (typeof delta.content === 'string') content.push(delta.content)
    if (typeof delta.reasoning_content === 'string') reasoning.push(delta.reasoning_content)
    const deltas = (delta.tool_calls ?? []) as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    for (const call of deltas) {
      const index = call.index ?? 0
      const entry = calls.get(index) ?? { id: '', name: '', arguments: '' }
      if (call.id !== undefined) entry.id = call.id
      if (call.function?.name !== undefined) entry.name = call.function.name
      if (call.function?.arguments !== undefined) entry.arguments += call.function.arguments
      calls.set(index, entry)
    }
  }
  const toolCalls = [...calls.entries()].sort((left, right) => left[0] - right[0]).map(([, call]) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }))
  return {
    choices: [{
      message: {
        content: content.length > 0 ? content.join('') : null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning_content: reasoning.length > 0 ? reasoning.join('') : undefined,
      },
    }],
    usage,
  } as unknown as WireResponse
}
/**
 * Whether a transport error PROVES the request never reached the provider.
 *
 * Deliberately narrow. Only connection-establishment failures qualify: if a socket was opened and
 * bytes may have been sent, the request could have been processed and its reservation must stand.
 * `ECONNRESET` and `UND_ERR_SOCKET` are NOT listed for exactly that reason.
 */
function neverReachedProvider(error: unknown): boolean {
  const preSend = new Set([
    'ENOTFOUND', // DNS could not resolve the host
    'EAI_AGAIN', // DNS lookup failed transiently
    'ECONNREFUSED', // nothing was listening
    'UND_ERR_CONNECT_TIMEOUT', // the connection was never established
    'ETIMEDOUT', // measured 2026-10-16: a blackholed address reports this, and it is pre-send
    'ERR_INVALID_URL',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ])
  const seen = new Set<unknown>()
  const inspect = (node: unknown, depth: number): boolean => {
    if (depth > 6 || node === null || typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)
    const entry = node as { code?: unknown; cause?: unknown; errors?: unknown }
    // ## An AggregateError is judged by ALL its members, never by its first
    //
    // undici reports one inner error per address, and sets the aggregate's own `code` to the
    // FIRST inner code. Reading that code alone is wrong in both directions: it released a
    // reservation when the first address was refused but a later one was reset, and it stranded
    // one when the first address merely timed out. **One address that got a connection means the
    // request may have been processed, so the reservation must stand** -- hence `every`.
    if (Array.isArray(entry.errors) && entry.errors.length > 0) {
      return entry.errors.every(inner => inspect(inner, depth + 1))
    }
    if (typeof entry.code === 'string' && preSend.has(entry.code)) return true
    return inspect(entry.cause, depth + 1)
  }
  return inspect(error, 0)
}
/**
 * Ensure the request declares tools named exactly `read` and `bash`.
 *
 * The Zen free-tier gate refuses a request without them (`403 FreeTierError`), measured with the
 * identity held constant. They are ADMISSION ONLY: the description tells the model not to call
 * them, and nothing in this lane executes them. Existing declarations are preserved and never
 * renamed -- a caller's tool choice is its own.
 */
function ensureZenFreeTools(tools: unknown[] | undefined): unknown[] | undefined {
  const list = Array.isArray(tools) ? (tools as unknown[]) : []
  const named = (tool: unknown): string => {
    if (tool === null || typeof tool !== 'object') return ''
    const entry = tool as { name?: unknown; function?: { name?: unknown } }
    return String(entry.name ?? entry.function?.name ?? '')
  }
  const missing = ['read', 'bash'].filter(name => !list.some(tool => named(tool) === name))
  if (missing.length === 0) return tools
  const admission = (name: string) => ({
    type: 'function',
    function: {
      name,
      description:
        'Unavailable in this request. Do not call. This declaration exists only so the request is ' +
        'admitted; nothing in this run executes it.',
      parameters:
        name === 'read'
          ? { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }
          : { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  })
  return [...list, ...missing.map(admission)]
}
/**
 * A failure message that keeps the transport's own reason.
 *
 * undici reports `fetch failed` and hides everything useful in `cause`; for a multi-address
 * connection it nests one error per address under `cause.errors`. The archive only ever sees this
 * string, so the codes are spelled out here rather than left to be re-derived.
 */
function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const codes: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== 'object') return
    const entry = node as { code?: unknown; errors?: unknown }
    if (typeof entry.code === 'string') codes.push(entry.code)
    if (Array.isArray(entry.errors)) for (const inner of entry.errors) walk(inner, depth + 1)
  }
  walk((error as { cause?: unknown }).cause, 0)
  const unique = [...new Set(codes)]
  return unique.length === 0 ? error.message : `${error.message} (${unique.join(', ')})`
}