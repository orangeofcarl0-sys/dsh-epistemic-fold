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
    const calls = message.content.filter(block => block.type === 'tool-call')
    if (calls.length === 0) return { role: 'assistant', content: text }
    return {
      role: 'assistant',
      content: text.length > 0 ? text : null,
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
}

/**
 * The live adapter. One instance serves one model route.
 */
export class OpenAiCompatibleAdapter extends LlmAdapter {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly contextWindow: number
  private readonly headers: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch

  constructor(options: LiveAdapterOptions) {
    super()
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.model = options.model
    this.contextWindow = options.contextWindow ?? 131_072
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
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

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    const tools = toWireTools(options.tools)
    if (tools !== undefined) body.tools = tools

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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: redactSecret(message, this.apiKey), code: 'LIVE_TRANSPORT' } },
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

    const payload = await response.json() as WireResponse
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
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: mapFinish(choice?.finish_reason, sawToolCall) }
  }
}
