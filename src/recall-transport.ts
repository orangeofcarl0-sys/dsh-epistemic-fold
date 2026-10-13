/**
 * The retrieval subagent's model call (docs/67).
 *
 * One auxiliary call through `ctx.llm.stream`, with the terminal finish mapped to
 * its fail-closed error. See the note on `completeWithContext` for why the purpose
 * label is `compaction`.
 *
 * @module dsh-epistemic-fold/recall-transport
 */

import { BlockAssembler, LlmError } from "@deepseek-ai/dsh-llm"
import type { FinishReason, GenerateOptions, RequestMessage } from "@deepseek-ai/dsh-llm"
import type { Context } from "@deepseek-ai/cordis"
import type { SessionId } from "@deepseek-ai/dsh-session"

export interface SubagentMessage {
  readonly role: "system" | "user"
  readonly text: string
}

// ---------------------------------------------------------------- the model call

/**
 * Map a terminal finish to its fail-closed error, as `rationale.ts` does.
 *
 * A truncated reply is an ERROR rather than a short answer: the subagent output is JSON
 * with three required faces, and a cap that cuts one of them off produces a reply that
 * parses as something else. Reporting it lets the caller retry or fall back; accepting it
 * silently would put a half-answer in the caller context wearing a complete one shape.
 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case "error":
    case "aborted": {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case "max-tokens": {
      const error = new Error("retrieval subagent reply truncated at the token cap") as Error & { code?: string }
      error.code = "MAX_TOKENS"
      return error
    }
    default:
      return undefined
  }
}

/**
 * One auxiliary model call for the retrieval subagent.
 *
 * ## Why the purpose is labelled `compaction`
 *
 * `GenerateOptions.purpose` is a closed union, `"compaction" | "session-title"`
 * (`@deepseek-ai/dsh-llm` types.d.ts:530), and there is no retrieval value. Labelling it
 * `compaction` is therefore the only type-safe choice, and it is a MISLABEL: a host that
 * attributes cost by purpose will bill these calls to compaction. The subagent counters
 * (`subagentRecallStats`) exist partly because of that: the calls are attributable from
 * here even when the transport label is not.
 *
 * The subagent deliberately does NOT replay the conversation prefix. A compaction call
 * reuses the prefix so the provider warm cache still applies; a retrieval question is
 * asked about the ARCHIVE, not about the live conversation, and shipping the live surface
 * to it would spend the budget this feature exists to protect.
 */
export async function completeWithContext(options: {
  readonly ctx: Context
  readonly target: { readonly provider: string; readonly model: string }
  readonly sessionId: SessionId
  readonly messages: readonly SubagentMessage[]
  readonly maxTokens: number
  readonly signal?: AbortSignal
}): Promise<string> {
  const assembler = new BlockAssembler()
  const messages: RequestMessage[] = options.messages.map(message => ({
    role: message.role,
    content: [{ type: "text", text: message.text }],
  })) as RequestMessage[]
  const generateOptions: GenerateOptions = {
    provider: options.target.provider,
    model: options.target.model,
    messages,
    maxTokens: options.maxTokens,
    sessionId: options.sessionId,
    purpose: "compaction",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  for await (const chunk of options.ctx.llm.stream(generateOptions)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const text = assembler.blocks().map(block => block.type === "text" ? block.text : "").join("\n").trim()
  if (text.length === 0) {
    throw new LlmError("retrieval subagent produced no text content", "UNSUPPORTED_CONTENT")
  }
  return text
}
