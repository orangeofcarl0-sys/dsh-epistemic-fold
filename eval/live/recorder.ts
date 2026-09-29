/**
 * RC0-B: the all-call billing recorder.
 *
 * R4-D measured RBCR from real provider counters — a large step up from modeled
 * cost — but it did so by calling `adapter.stream()` from the benchmark with a
 * hand-built request. That has two consequences the RC0 audit identified, and
 * both make the number weaker than its name:
 *
 * 1. **It is not the DSH agent's wire shape.** `surfaceAsPrompt()` flattens the
 *    session into ONE user message, so the real system prompt, the EF framing
 *    section, the tool schemas, and the true role structure are all absent.
 *    Those affect prompt tokens, cache prefix, and therefore the bill — and the
 *    R3 framing change specifically EARNS its saving through real system-prompt
 *    assembly.
 * 2. **It omits every auxiliary call.** Basic's fold makes a real
 *    `purpose: 'compaction'` provider call that costs money. The economy arm
 *    uses `semanticMode: 'none'` and mostly does not. Only main requests were
 *    recorded, so Basic's bill was UNDERSTATED.
 *
 * This module fixes both by recording at the LLM seam instead of around it. A
 * decorator wraps the real adapter, so the agent loop drives everything exactly
 * as it does in production and every call is captured with its purpose:
 *
 *   DSH agent → ctx.llm → BillingRecorder → real provider adapter
 *
 * `FullTaskRBCR` is then `Σ C(all calls, EF) / Σ C(all calls, Basic)` — the
 * release metric, rather than the main-request-only approximation.
 *
 * @module eval/live/recorder
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { RequestClass } from './billing.ts'

/**
 * What a provider call was for. `main` is the user's own request; everything
 * else is charged to the same budget and must be counted.
 */
export type CallPurpose = 'main' | 'compaction' | 'rationale' | 'other'

/**
 * One recorded attempt, including the ones that returned nothing.
 *
 * A call with `success: false` and no tokens is a transport failure: it cost
 * nothing but it IS a reliability event, so it is recorded rather than dropped.
 */
export interface RecordedCall {
  /** Which arm produced it, for the paired comparison. */
  readonly arm: string
  /** Sequential index within the run, for ordering and retry attribution. */
  readonly index: number
  /** Stable id, so a retry can name the attempt it repeats. */
  readonly callId: string
  readonly purpose: CallPurpose
  readonly requestClass: RequestClass
  readonly provider: string
  readonly model: string
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens?: number
  readonly outputTokens: number
  /** Tokens the provider charged for: uncached + cache read. */
  readonly promptTokens: number
  /** Whether the provider ANSWERED. An error finish with usage still cost money. */
  readonly success: boolean
  /** The attempt this call retried, when it is a retry. */
  readonly retryOf?: string
  /** The provider's failure message, when it failed. */
  readonly failure?: string
}

/** What preceded a call, so realization can be reported per class (R4 §24). */
export interface CallContext {
  readonly requestClass: RequestClass
}

/**
 * A recording decorator over any `LlmAdapter`.
 *
 * It is a decorator rather than a subclass of the live adapter so it can wrap
 * ANY provider implementation — including the keyless harness's scripted
 * adapter — which is what makes the billing path testable without a provider.
 *
 * It never swallows or rewrites a chunk: the recorded stream is the wrapped
 * stream, so wrapping cannot change what the agent sees.
 */
export class BillingRecorder extends LlmAdapter {
  private readonly calls: RecordedCall[] = []
  private index = 0
  /** Set by the driver so each call is attributed to a request class. */
  private requestClass: RequestClass = 'normal'
  /** Set when the NEXT call is a retry of a failed one. */
  private retryOf: string | undefined

  constructor(
    private readonly inner: LlmAdapter,
    private readonly arm: string,
  ) {
    super()
  }

  /** Every attempt this recorder observed, in order. */
  get bill(): readonly RecordedCall[] {
    return [...this.calls]
  }

  /** Attempts that returned nothing and would be retried. */
  get failedCalls(): readonly RecordedCall[] {
    return this.calls.filter(call => !call.success)
  }

  /** Mark the class of the next call (R4 §24's per-class realization). */
  markNextRequest(requestClass: RequestClass): void {
    this.requestClass = requestClass
  }

  /** Mark the next call as a retry of `callId`, so retry cost is attributable. */
  markNextAsRetryOf(callId: string): void {
    this.retryOf = callId
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.inner.resolveModel(provider, model, signal)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.index
    this.index += 1
    const callId = `${this.arm}-${index}`
    const purpose = classifyPurpose(options)
    const requestClass = this.requestClass
    const retryOf = this.retryOf
    // Consume the one-shot markers so the NEXT call is classified afresh.
    this.requestClass = 'normal'
    this.retryOf = undefined

    let usage: TokenUsage | undefined
    let failure: string | undefined
    for await (const chunk of this.inner.stream(options)) {
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        failure = chunk.reason.failure.message
      }
      // Passed through untouched: recording must not change the agent's view.
      yield chunk
    }

    const cacheRead = usage?.cacheReadTokens ?? 0
    const uncached = usage?.inputTokens ?? 0
    this.calls.push({
      arm: this.arm,
      index,
      callId,
      purpose,
      requestClass,
      provider: options.provider,
      model: options.model,
      uncachedInputTokens: uncached,
      cacheReadTokens: cacheRead,
      ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      outputTokens: usage?.outputTokens ?? 0,
      promptTokens: uncached + cacheRead,
      // A call that produced no usage AND reported a failure is a transport
      // failure. A call with usage but an error finish still cost money, so
      // success means "the provider answered", not "the agent was satisfied".
      success: failure === undefined && usage !== undefined,
      ...(retryOf === undefined ? {} : { retryOf }),
      ...(failure === undefined ? {} : { failure }),
    })
  }
}

/**
 * Classify one call from its `GenerateOptions`.
 *
 * `purpose` is DSH's own discriminator and is the only reliable signal: a
 * compaction call is issued by the compaction backend, not by the agent loop.
 * An unmarked call is `main`, because that is what the agent loop issues.
 */
export function classifyPurpose(options: GenerateOptions): CallPurpose {
  if (options.purpose === 'compaction') return 'compaction'
  if (options.purpose === 'session-title') return 'other'
  return 'main'
}

/** Whether one call was billable at all (a transport failure with no usage). */
export function isBillable(call: RecordedCall): boolean {
  return call.promptTokens > 0 || call.outputTokens > 0
}
