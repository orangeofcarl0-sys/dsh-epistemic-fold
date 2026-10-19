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

/**
 * The rationale instruction, which now DEPENDS on whether the machine sections are populated.
 *
 * ## Why it is conditional, and what was measured
 *
 * The instruction used to assert unconditionally that the machine sections were produced by a
 * deterministic state engine and are authoritative, and then FORBADE the rationale from stating
 * current state, constraints, or failure status. That division of labour is correct only when
 * those sections actually carry something.
 *
 * Measured 2026-10-18: a quality fold of 100 prose documents produced state.anchors = 0 -- no
 * objective, no state heads, no constraints, no evidence, no open items -- so every machine
 * section was empty, the rationale was forbidden from carrying state, and the checkpoint's
 * entire text was the 47-character marker [EF1 L cp:...]. The facts had no carrier at all.
 *
 * So: with anchors, the rationale REFERENCES them by id and still does not restate their values
 * (the original rule, which is sound). Without anchors, the rationale is the only carrier and
 * must say what is worth keeping. One instruction cannot do both.
 */
function rationaleInstruction(anchorCount: number, hintTokens: number): string {
  const base = anchorCount > 0 ? RATIONALE_INSTRUCTION_WITH_ANCHORS : RATIONALE_INSTRUCTION_NO_ANCHORS
  return base.replace(/\{hint\}/gu, String(hintTokens))
}

const RATIONALE_INSTRUCTION_WITH_ANCHORS = [
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
  'When you need to refer to a specific decision, constraint or failure, cite its anchor id in',
  'square brackets exactly as the machine sections write it -- do not restate its value.',
  'Output up to {hint} tokens of terse engineering prose. Output only the rationale text.',
].join('\n')

/**
 * The variant used when NO anchor exists, so the machine sections are all empty.
 *
 * The prohibitions are dropped deliberately: they exist to avoid duplicating an authoritative
 * section, and there is no section to duplicate. Keeping them would leave the checkpoint with
 * no carrier for the facts at all, which is the measured defect this file documents.
 */
const RATIONALE_INSTRUCTION_NO_ANCHORS = [
  'You are acting as the RATIONALE writer for a checkpoint of the conversation above.',
  'This checkpoint carries NO machine sections -- the deterministic state engine produced no',
  'anchors for this span -- so YOU are the only carrier of what is worth keeping.',
  'Write terse engineering prose that preserves, in this order of priority:',
  '- the operative facts, names, values and identifiers stated in the conversation',
  '- decisions that were made and why',
  '- corrections or errata that supersede earlier figures',
  '- alternatives considered and rejected',
  'Be concrete and specific: a later reader must be able to act on this without the original.',
  'Output up to {hint} tokens. Output only the rationale text.',
].join('\n')

/**
 * Output budget for a rationale over a span of this many tokens.
 *
 * ## Symmetric with `rationaleInputFor`, and for the same reason
 *
 * `docs/21` §11.5 established the principle for the INPUT side: the rationale call receives the
 * folded span, so its cost must be DERIVED from that span rather than carried as a constant
 * measured at one window size. The OUTPUT side was left as a constant (`400`) and that is the
 * defect this function removes.
 *
 * A digest of a span grows with the span, but far slower than linearly -- it is a compression.
 * Measured 2026-10-18: a 1,043,005-token span produced a 2,468-character (~620-token) digest
 * once the cap allowed it. A span/256 slope reaches 620 tokens at ~159,000 tokens of span,
 * which brackets that observation without pretending to predict it.
 *
 * ## The floor is 16384, and both 1024 and 4096 were measured to be too small
 *
 * The two budgets must be far apart, not merely ordered, because the model spends part of the
 * real budget REASONING before it writes any text. Measured three times:
 *
 *   real 1024  (hint 800,  1.28x)  chars 0   UNSUPPORTED_CONTENT   accuracy 0.6176, 0.5490
 *   real 4096  (hint 800,  5.12x)  chars 1824  accuracy 0.9363   -- worked ONCE, then failed
 *                                                                 3/3 across all three tiers
 *   real 16384                     the floor below
 *
 * 4096 is marginal rather than wrong: it sufficed once and then did not, which is what a budget
 * sitting near the reasoning overhead looks like. 16384 is 10x the largest tier hint (1600), so
 * the model is bounded by the INSTRUCTION rather than by a tripwire -- and a tripwire here does
 * not truncate, it discards the entire call: `text.length === 0` throws `UNSUPPORTED_CONTENT`,
 * the caller pays for a request that produced nothing, and the checkpoint falls back to the
 * marker line.
 *
 * @param foldSpanTokens - tokens of the span this fold replaces.
 * @returns the output token budget for the auxiliary call.
 */
export function rationaleOutputFor(foldSpanTokens: number): number {
  const slope = Math.round(Math.max(0, foldSpanTokens) / 256)
  return Math.min(32_768, Math.max(16_384, slope))
}

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
    // ## `max-tokens` is NOT an error any more (2026-10-18)
    //
    // It used to throw, and the engine's catch set `semanticText = undefined` -- so a rationale
    // that reached its cap was DISCARDED rather than truncated, and the checkpoint fell back to
    // the bare marker. Measured: RATIONALE_MAX_TOKENS was 400 while the instruction asked for
    // "100-400 tokens", so a model writing the top of its requested range lost everything
    // (rationaleFailures 1, reason MAX_TOKENS, chars 0, arm A 0.5961).
    //
    // The fail-closed intent -- never land a half-written digest as if it were complete -- is
    // served by MARKING the truncation, not by deleting the work. A partial manifest is strictly
    // better than none: the model can act on some of the facts, and it can call context_recall
    // for the rest. Once tiers carry DIFFERENT budgets, hitting a cap is expected rather than
    // exceptional, so discarding would make every small-budget tier degenerate to nothing.
    case 'max-tokens': {
      return undefined
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
  /** Anchors the machine sections will carry; 0 selects the no-anchor instruction. */
  anchorCount: number
  /** The tier's HINT budget; the real budget is `maxTokens`, several times larger. */
  hintTokens: number
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
      content: [{ type: 'text', text: rationaleInstruction(options.anchorCount, options.hintTokens) }],
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
  // ## An empty digest must say WHICH empty it was
  //
  // This message used to be the bare string, and that made three different failures
  // indistinguishable in every artifact they reached: (a) the model spent the whole output
  // budget on reasoning and finished max-tokens with no content, (b) the model genuinely emitted
  // nothing, (c) the stream ended early with no blocks. Each needs a different response -- a
  // bigger budget, a different instruction, or a transport retry -- and the artifact said only
  // "produced no text content", which reads as (b) for all three.
  //
  // Measured 2026-10-19: one fold in six at the 1M tier failed this way with a 16,384-token
  // budget while its five siblings produced ~444 tokens of content each, so the budget itself
  // was not obviously the cause and there was no way to tell from the result file. The finish
  // kind, the assembled block count and the usage cost nothing and are the whole attribution.
  if (text.length === 0) {
    const usage = assembler.usage
    throw new LlmError(
      'rationale produced no text content'
        + ' (finish=' + assembler.finish.kind
        + ', blocks=' + rawOutput.length
        + ', outputTokens=' + (usage === undefined ? 'unknown' : usage.outputTokens)
        + ', inputTokens=' + (usage === undefined ? 'unknown' : usage.inputTokens)
        + ', maxTokens=' + options.maxTokens + ')',
      'UNSUPPORTED_CONTENT',
    )
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
