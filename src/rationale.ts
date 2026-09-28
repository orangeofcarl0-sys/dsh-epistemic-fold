/**
 * Rationale-only semantic compiler (R0-A): a small, purpose-built auxiliary
 * call that writes ONLY the Rationale slot of the structured checkpoint —
 * why decisions were made, conceptual context, alternatives considered.
 * It is explicitly forbidden from asserting state, completion, validation
 * status, constraints, current values, or failure resolution, because the
 * machine sections above it are the authority (D-006, R0-A §15).
 *
 * @module dsh-epistemic-fold/rationale
 */

import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  RequestMessage,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

const RATIONALE_INSTRUCTION = [
  'You are acting as the RATIONALE writer for a checkpoint whose machine sections (Current / Evidence / Open) are already produced by a deterministic state engine and are authoritative.',
  'Write ONLY explanatory rationale for the conversation above. Summarize exactly:',
  '- why the decisions that were made were made',
  '- conceptual context and background an engineer would want',
  '- alternatives that were considered and rejected, and why',
  'Do NOT assert or restate any of the following — they are owned by the machine sections:',
  '- current state or current values',
  '- task completion or progress claims',
  '- validation / test status',
  '- active constraints',
  '- whether failures are resolved or open',
  'Output 100-400 tokens of terse engineering prose. Output only the rationale text.',
].join('\n')

export interface RationaleCallResult {
  readonly text: string
  /** Exact auxiliary-call envelope, forwarded into `compaction/summary`. */
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly usage?: TokenUsage
  readonly rawOutput: ContentBlock[]
  readonly llmStreamCall: true
}

/** Map a terminal rationale finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('rationale truncated at the token cap') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * Run the rationale-only auxiliary call over the same replayed conversation
 * prefix Basic uses (so the provider's warm prefix cache still applies), with
 * the EF rationale instruction as the final user message.
 * @returns rationale text plus the REAL call envelope for durable audit.
 */
export async function rationaleOnly(options: {
  ctx: Context
  target: { provider: string; model: string }
  maxTokens: number
  input: { readonly tools?: readonly unknown[]; readonly messages: readonly Message[] }
  agent: Agent
  signal?: AbortSignal | undefined
}): Promise<RationaleCallResult> {
  const { ctx, agent } = options
  const assembler = new BlockAssembler()
  const messages: RequestMessage[] = [
    ...options.input.messages,
    deepFreeze({
      role: 'user',
      content: [{ type: 'text', text: RATIONALE_INSTRUCTION }],
    }),
  ]
  const generateOptions: GenerateOptions = {
    provider: options.target.provider,
    model: options.target.model,
    messages,
    toolHistory: agent.session.toolHistory(),
    ...(options.input.tools === undefined ? {} : { tools: [...options.input.tools] as never }),
    maxTokens: options.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  for await (const chunk of ctx.llm.stream(generateOptions)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const text = rawOutput
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
    .trim()
  if (text.length === 0) {
    throw new LlmError('rationale produced no text content', 'UNSUPPORTED_CONTENT')
  }
  return {
    text,
    provider: generateOptions.provider,
    model: generateOptions.model,
    maxTokens: options.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    rawOutput,
    llmStreamCall: true,
  }
}
