/**
 * The real agent loop both live recall suites drive (RC1.2-A, RC1.3).
 *
 * Extracted so the two suites cannot diverge: RC1.2 established the mechanism
 * through this loop, and RC1.3 changes only the PROBE TEXT and the ANALYSIS, so
 * a difference between their results is attributable to the probe rather than to
 * two subtly different harnesses.
 *
 * The loop is minimal but real in the one way that matters:
 *
 *   model -> tool-call -> ToolRuntime.execute -> tool/result -> next model step
 *
 * @module tests/recall-loop
 */

import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'

/** The model route every live recall suite uses. */
export const MODEL_OPTIONS = { provider: 'live', model: 'live' } as const

/**
 * How many model→tool→model rounds a probe may take before it is cut off.
 *
 * Raised from 3 after the first run: the model's real path is
 * `context_search` → `context_recall(summary)` → `context_recall(exact)` →
 * answer, so a 3-round cap truncated it mid-thought and the empty answer was
 * then scored as a WRONG answer. That is the same defect R4-E had to fix, and it
 * is why `truncated` is reported separately from a wrong answer.
 */
export const MAX_ROUNDS = Number(process.env.EF_LIVE_RECALL_ROUNDS ?? 6)

/**
 * Deterministic filler with NO DIGITS in its labels.
 *
 * This is load-bearing, not cosmetic. The filler's unit index used to be a
 * decimal number, so a 250-unit filler block contained `unit 64`, `unit 90` and
 * `unit 30` — the exact tokens the fact matchers look for. A retained tail of
 * filler therefore made `\b64\b` match the surface, which (a) defeated the
 * premise check that the facts had left the surface, and (b) let an answer score
 * a point by reading a unit index rather than the fact. The index is now
 * base-26 letters, so the ONLY source of a fact token is the fact.
 */
export function filler(label: string, units: number): string {
  return Array.from(
    { length: units },
    (_, index) => `${label} unit ${letters(index)} ${'payload '.repeat(12)}`,
  ).join(' ')
}

/** A decimal index as base-26 letters (`a`, `b`, … `z`, `aa`, …). */
function letters(value: number): string {
  let remaining = value
  let out = ''
  do {
    out = String.fromCharCode(97 + (remaining % 26)) + out
    remaining = Math.floor(remaining / 26) - 1
  } while (remaining >= 0)
  return out
}

/**
 * The three facts, planted as ORDINARY PROSE with no anchor declared.
 *
 * This is the whole point: a user states these once and expects them
 * remembered. Nothing here goes through the authority gate, so the only way
 * they survive a fold is a checkpoint that carries prose, or recall.
 */
export const FACTS = {
  constraint: 'Our batch size must never exceed 64 items.',
  superseded: 'The parser timeout was 30 seconds.',
  supersession: 'CORRECTION: the parser timeout is now 90 seconds, superseding the 30.',
  exact: 'The failing error code we are chasing is PARSE-7741.',
} as const

/**
 * One probe question, paired with the matcher that decides whether a text
 * carries its answer.
 *
 * The matchers live here, beside the facts, so the answer score, the
 * "did a tool return it" score, and the failure taxonomy all use the SAME
 * definition of "carries the fact". Three copies of this logic is how a suite
 * ends up reporting that a fact was retrieved and not retrieved at once.
 */
export interface FactProbe {
  readonly id: string
  /** The question asked about this fact. */
  readonly question: string
  /** Whether `text` carries the fact. */
  readonly present: (text: string) => boolean
}

/**
 * The supersession matcher: what the text ASSERTS, not which numbers it names.
 *
 * A correct answer very often says "90 seconds, superseding the earlier 30" —
 * and a matcher that penalized any occurrence of `30` scored that as WRONG for
 * naming the very value it correctly identified as obsolete. So `30` counts
 * against the text only when it appears in a clause that does NOT mark it
 * superseded.
 */
export function assertsSupersession(text: string): boolean {
  const clauses = text
    .split(/[.;,\n]/u)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0)
  const supersessionMarkers = /supersed|earlier|original|previous|old\b|was\b|no longer|now\b|revis|correct/i
  const claimsNinety = clauses.some(clause => /\b90\b/u.test(clause))
  const claimsThirtyAsCurrent = clauses.some(clause =>
    /\b30\b/u.test(clause) && !supersessionMarkers.test(clause))
  return claimsNinety && !claimsThirtyAsCurrent
}

/** The three facts as probes, in the order the probe asks about them. */
export const FACT_PROBES: readonly FactProbe[] = [
  { id: 'constraint', question: '1. What is the maximum batch size?', present: text => /\b64\b/u.test(text) },
  { id: 'supersession', question: '2. What is the parser timeout in seconds?', present: assertsSupersession },
  { id: 'exact', question: '3. What is the exact failing error code?', present: text => /PARSE-7741/u.test(text) },
]

/**
 * Score an answer against the three facts.
 *
 * Kept as a named shape (rather than only the generic per-fact map) because
 * RC1.2's recorded results use it, and a silent change of meaning would make
 * those numbers incomparable with new ones.
 */
export function scoreAnswer(answer: string): {
  readonly constraint: boolean
  readonly supersession: boolean
  readonly exact: boolean
  readonly total: number
} {
  const byFact = scoreFacts(answer)
  const constraint = byFact.get('constraint') === true
  const supersession = byFact.get('supersession') === true
  const exact = byFact.get('exact') === true
  return { constraint, supersession, exact, total: Number(constraint) + Number(supersession) + Number(exact) }
}

/** Which of the three facts `text` carries. */
export function scoreFacts(text: string): Map<string, boolean> {
  return new Map(FACT_PROBES.map(probe => [probe.id, probe.present(text)]))
}

/** A session whose early prose carries the facts, and which then grows. */
export function seedNarrative(prefix: string): SessionType {
  const session = Session.create(SessionId(`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text:
      `Some context before we start. ${FACTS.constraint} ${FACTS.superseded} `
      + `${FACTS.supersession} ${FACTS.exact} Please keep all of this in mind.` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: filler('background', 40) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** One tool call the loop executed, with what came back. */
export interface ToolStep {
  readonly round: number
  readonly name: string
  /** A short preview of the arguments, for the report. */
  readonly argsPreview: string
  readonly isError: boolean
  readonly outputChars: number
}

/** What one probe's agent loop actually did. */
export interface LoopOutcome {
  readonly answer: string
  readonly rounds: number
  readonly searchCalls: number
  readonly recallCalls: number
  readonly otherCalls: number
  /** Characters of tool output the loop fed back to the model. */
  readonly recalledChars: number
  /**
   * Whether the tool output the loop received carried each fact.
   *
   * This separates two questions the smoke could otherwise conflate:
   *
   *   did a tool RETURN the folded facts?   (a property of the mechanism)
   *   did the model then USE them?          (a property of the model)
   *
   * **It is only defined for arms that HAVE EF recall tools.** Real Basic has no
   * Bundle and no `context_search` / `context_recall`, so scoring Basic on this
   * is meaningless — and reporting it as `Basic 2/5` is precisely the error
   * RC1.2.1 corrected. Callers must read it only for EF arms.
   */
  readonly toolOutputFacts: ReturnType<typeof scoreAnswer>
  /** Text every `context_search` call returned. */
  readonly searchOutput: string
  /** Text every `context_recall` call returned. */
  readonly recallOutput: string
  /** Every tool call in order, for the taxonomy and the report. */
  readonly toolSteps: readonly ToolStep[]
  /** Model calls the loop made. */
  readonly providerCalls: number
  /**
   * Whether the loop hit the round cap while STILL calling tools.
   *
   * A truncated loop has no final answer, and scoring its empty string as wrong
   * would convert "the harness ran out of rounds" into "the policy lost a fact".
   * Such a replicate is reported and EXCLUDED from the quality tally.
   */
  readonly truncated: boolean
}

/** Assemble the system prompt and tool schemas a production request carries. */
export async function assemble(harness: Harness): Promise<{
  readonly system?: string
  readonly tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
}> {
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[] }> }
    | undefined
  if (service?.assemble === undefined) {
    throw new Error(
      'recall smoke: no SystemPrompt service is mounted, so the request shape would differ from '
      + 'production. A live measurement must fail loud rather than measure a request that carries '
      + 'no system prompt (RC0/RC1 both proved this with real incidents).',
    )
  }
  // NO silent catch. An assembly failure changes the WIRE SHAPE, and a live
  // measurement taken over a corrupted shape is worse than no measurement —
  // that is exactly how the R3 framing change was once measured against a
  // request that never carried a system prompt at all.
  const assembly = await service.assemble({})
  const text = (assembly.sections ?? [])
    .map(section => section.text ?? '')
    .filter(part => part.length > 0)
    .join(String.fromCharCode(10, 10))
  return {
    ...(text.length === 0 ? {} : { system: text }),
    ...(assembly.tools === undefined || assembly.tools.length === 0 ? {} : { tools: assembly.tools }),
  }
}

/** The session surface as request messages. */
export function surfaceMessages(session: SessionType): unknown[] {
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  return messages
}

/**
 * The current surface as plain text.
 *
 * Used to check the PREMISE of a retrieval measurement: if a fact is still on
 * the surface, a model that answers it did not retrieve anything, and a model
 * that says "unknown" while it is visible is failing at reading rather than at
 * recall. Either way the run measures something other than retrieval.
 */
export function surfaceText(session: SessionType): string {
  const parts: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    parts.push(message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
  }
  return parts.join('\n')
}

/** Which facts the surface still carries, so a retrieval claim has a premise. */
export function factsOnSurface(session: SessionType): Map<string, boolean> {
  const surface = surfaceText(session)
  return new Map(FACT_PROBES.map(probe => [probe.id, probe.present(surface)]))
}

/**
 * Drive one real agent loop and return what it did.
 *
 * The loop is deliberately minimal but REAL in the one way that matters: a tool
 * call is executed through `ctx.tools.execute`, its result is appended to the
 * session as a durable `tool/result`, and the model is asked again. That is the
 * path `context_search` → `context_recall` → answer.
 *
 * @param harness - a harness mounted with `tools: true`.
 * @param session - the session to probe.
 * @param question - the probe text.
 * @returns the final answer plus the loop's own telemetry.
 */
export async function runRecallLoop(
  harness: Harness,
  session: SessionType,
  question: string,
): Promise<LoopOutcome> {
  session.append('turn/start', { turn: 900 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: question }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const { system, tools } = await assemble(harness)
  let answer = ''
  let rounds = 0
  let searchCalls = 0
  let recallCalls = 0
  let otherCalls = 0
  let recalledChars = 0
  // Counts CALLS, not chunks. The previous version incremented inside the
  // `for await` over the stream, so it counted stream chunks and the name lied.
  // `BillingRecorder.bill.length` is the real provider-call count.
  let providerCalls = 0
  let truncated = false
  let recalledText = ''
  let searchOutput = ''
  let recallOutput = ''
  const toolSteps: ToolStep[] = []

  const agent = { session, options: MODEL_OPTIONS } as never

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    rounds = round + 1
    // The last round is allowed to be a tool round, but if it is, the loop was
    // cut off rather than finished.
    const isLastRound = round === MAX_ROUNDS - 1
    const messages = surfaceMessages(session)
    let text = ''
    const toolCalls: Array<{ id: string; name: string; args: string }> = []

    providerCalls += 1
    for await (const chunk of harness.ctx.llm.stream({
      provider: MODEL_OPTIONS.provider,
      model: MODEL_OPTIONS.model,
      messages,
      ...(system === undefined ? {} : { system }),
      ...(tools === undefined ? {} : { tools }),
      maxTokens: 300,
    } as never)) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCalls.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments })
      }
    }

    answer = text.length > 0 ? text : answer

    // No tool call means the loop is done — the model answered.
    if (toolCalls.length === 0) break
    if (isLastRound) truncated = true

    // Commit the assistant turn carrying the calls, so the next request sees it.
    session.append('step/start', { turn: 900, step: round + 1 })
    session.append('assistant/message', {
      stream: [], turn: 900, step: round + 1,
      message: createMessage({
        role: 'assistant',
        content: [
          ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
          ...toolCalls.map(call => ({
            type: 'tool-call' as const,
            id: ToolCallId(call.id),
            name: call.name,
            arguments: call.args,
          })),
        ],
        source: { kind: 'model', ...MODEL_OPTIONS },
      }),
    }, { surfaceOp: 'append' })

    for (const call of toolCalls) {
      const callId = ToolCallId(call.id)
      session.append('tool/call', { turn: 900, step: round + 1, callId, name: call.name, arguments: call.args })
      if (call.name === 'context_search') searchCalls += 1
      else if (call.name === 'context_recall') recallCalls += 1
      else otherCalls += 1

      // THE EXECUTION, through the real runtime. A recall tool that cannot run
      // here would make the loop report "the model did not recall" when the
      // truth is "the model was not allowed to".
      let content: ContentBlock[]
      // A thrown execution is an ERROR result, and the model must be told so.
      // The previous version wrote failure text but passed `isError: false`,
      // which tells the model the tool SUCCEEDED while its content says it did
      // not — the worst of both, because the model may then treat the failure
      // message as data.
      let isError = false
      try {
        const result = await harness.ctx.tools.execute({
          callId,
          name: call.name,
          arguments: safeParse(call.args),
          agent,
          signal: SIGNAL,
        })
        content = result.content as ContentBlock[]
        isError = result.isError
      } catch (error: unknown) {
        isError = true
        content = [{
          type: 'text',
          text: `tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }]
      }
      const rendered = content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
      recalledChars += rendered.length
      recalledText += rendered
      // Kept separate so the taxonomy can tell a SEARCH hit from a RECALL
      // return: "search found it and the model stopped" is a different failure
      // from "recall did not return it", and only the second implicates EF.
      if (call.name === 'context_search') searchOutput += rendered
      if (call.name === 'context_recall') recallOutput += rendered
      toolSteps.push({
        round: round + 1,
        name: call.name,
        argsPreview: call.args.replace(/\s+/gu, ' ').slice(0, 160),
        isError,
        outputChars: rendered.length,
      })
      session.append('tool/result', {
        turn: 900, step: round + 1,
        message: createToolResultMessage({ callId, content, isError }),
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn: 900, step: round + 1 })
  }

  session.append('turn/end', { turn: 900, reason: { kind: 'completed' } })
  return {
    answer, rounds, searchCalls, recallCalls, otherCalls, recalledChars, providerCalls, truncated,
    // Scored with the SAME function as the answer, so "a tool returned the
    // fact" and "the model said it" are measured identically and comparable.
    toolOutputFacts: scoreAnswer(recalledText),
    searchOutput,
    recallOutput,
    toolSteps,
  }
}

/** Parse tool arguments, tolerating a model that emits malformed JSON. */
export function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

/**
 * Grow the session and fold it, so the facts end up inside a checkpoint.
 *
 * @returns the number of leaf folds that actually landed.
 */
export async function growAndFold(
  harness: Harness,
  session: SessionType,
  steps: number,
  tokensPerStep: number,
): Promise<number> {
  const meter = harness.ctx.tokenMeter
  let folds = 0
  for (let step = 2; step <= steps + 1; step += 1) {
    session.append('turn/start', { turn: step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: filler(`step ${step}`, Math.ceil(tokensPerStep / 12)) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const before = meter.measure(session).totalTokens
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision */ }
    if (meter.measure(session).totalTokens < before) folds += 1
    session.append('turn/end', { turn: step, reason: { kind: 'completed' } })
  }
  return folds
}
