/**
 * RC1.2-A: the recall smoke that actually executes tools.
 *
 * RC1.1's narrative smoke asked the model a question and collected text deltas.
 * It never executed a tool call, so a model that correctly decided "this fact is
 * in an older checkpoint, I should search for it" had no way to act — the probe
 * could only observe what the SURFACE carried. That supports:
 *
 *   the marker-only checkpoint surface does not directly retain undeclared narrative
 *
 * and it does NOT support the stronger claim that was written down:
 *
 *   EF economy cannot recover undeclared narrative
 *
 * `context_search` and `context_recall` are exactly the mechanism EF provides
 * for recovering folded raw history, and they were never invoked. So this smoke
 * drives a real loop:
 *
 *   model -> tool-call -> ToolRuntime.execute -> tool/result -> next model step
 *
 * bounded to a few rounds so a confused model cannot loop forever, and recording
 * what the loop actually did (calls, recalled tokens, cost) rather than only the
 * final answer.
 *
 * @module tests/rc12a-recall-loop
 */

import { describe, expect, it } from 'vitest'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { BillingRecorder } from '../eval/live/recorder.ts'
import { summarizeFullBill } from '../eval/live/billing.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'
import { resolvePreset } from '../src/preset.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'
const MODEL_OPTIONS = { provider: LIVE_PROVIDER, model: 'live' }

/**
 * How many model→tool→model rounds a probe may take before it is cut off.
 *
 * Raised from 3 after the first run: the model's real path is
 * `context_search` → `context_recall(summary)` → `context_recall(exact)` →
 * answer, so a 3-round cap truncated it mid-thought and the empty answer was
 * then scored as a WRONG answer. That is the same defect R4-E had to fix, and it
 * is why `truncated` is now reported separately from a wrong answer.
 */
const MAX_ROUNDS = Number(process.env.EF_LIVE_RECALL_ROUNDS ?? 6)

function flash(): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json'), 'utf8'),
  ))
}

/** Deterministic filler. */
function filler(label: string, units: number): string {
  return Array.from(
    { length: units },
    (_, index) => `${label} unit ${index} ${'payload '.repeat(12)}`,
  ).join(' ')
}

/**
 * The three facts, planted as ORDINARY PROSE with no anchor declared.
 *
 * This is the whole point: a user states these once and expects them
 * remembered. Nothing here goes through the authority gate, so the only way
 * they survive a fold is a checkpoint that carries prose, or recall.
 */
const FACTS = {
  constraint: 'Our batch size must never exceed 64 items.',
  superseded: 'The parser timeout was 30 seconds.',
  supersession: 'CORRECTION: the parser timeout is now 90 seconds, superseding the 30.',
  exact: 'The failing error code we are chasing is PARSE-7741.',
}

function seedNarrative(): SessionType {
  const session = Session.create(SessionId(`rc12-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
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
async function assemble(harness: Harness): Promise<{
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
function surfaceMessages(session: SessionType): unknown[] {
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  return messages
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
      provider: LIVE_PROVIDER,
      model: 'live',
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
  }
}

/** Parse tool arguments, tolerating a model that emits malformed JSON. */
function safeParse(raw: string): unknown {
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
async function growAndFold(
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

const PROBE = [
  'Answer these three questions about our earlier conversation, one line each, no preamble.',
  'If a value is not available, say "unknown" rather than guessing.',
  '',
  'You have context_search and context_recall tools that can read folded history —',
  'use them if the answer is not on the current surface.',
  '',
  '1. What is the maximum batch size?',
  '2. What is the parser timeout in seconds?',
  '3. What is the exact failing error code?',
].join('\n')

/**
 * Score an answer against the three facts.
 *
 * The supersession check is about what the answer ASSERTS, not which numbers it
 * mentions. A correct answer very often says "90 seconds, superseding the
 * earlier 30" — and a check that penalized any occurrence of `30` scored that as
 * WRONG for naming the very value it correctly identified as obsolete. The first
 * version of this function did exactly that, under-counting every arm.
 *
 * So `30` counts against the answer only when it appears in a clause that does
 * NOT mark it as superseded.
 */
export function scoreAnswer(answer: string): {
  readonly constraint: boolean
  readonly supersession: boolean
  readonly exact: boolean
  readonly total: number
} {
  const constraint = /\b64\b/u.test(answer)
  const exact = /PARSE-7741/u.test(answer)

  // Split into clauses so a mention can be read in its own context.
  const clauses = answer
    .split(/[.;,\n]/u)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0)
  const supersessionMarkers = /supersed|earlier|original|previous|old\b|was\b|no longer|now\b|revis|correct/i
  const claimsNinety = clauses.some(clause => /\b90\b/u.test(clause))
  // A `30` claim is a failure only when its clause does not mark it obsolete.
  const claimsThirtyAsCurrent = clauses.some(clause =>
    /\b30\b/u.test(clause) && !supersessionMarkers.test(clause))
  const supersession = claimsNinety && !claimsThirtyAsCurrent

  return {
    constraint,
    supersession,
    exact,
    total: Number(constraint) + Number(supersession) + Number(exact),
  }
}

describe('RC1.2-A: the supersession check reads assertions, not mentions', () => {
  it('accepts a correct answer that NAMES the superseded value', () => {
    // The defect this pins: the first version penalized any occurrence of `30`,
    // so a correct answer that explained the supersession was scored WRONG. The
    // real run produced exactly that phrasing.
    const correct = '1. Maximum batch size: 64 items. 2. Parser timeout: 90 seconds '
      + '(the 30-second value was explicitly superseded by a correction). 3. PARSE-7741.'
    const scored = scoreAnswer(correct)
    expect(scored.constraint).toBe(true)
    expect(scored.supersession).toBe(true)
    expect(scored.exact).toBe(true)
    expect(scored.total).toBe(3)
  })

  it('still rejects an answer that asserts the OLD value', () => {
    // The family's whole purpose: recalling 30 as current is a failure.
    const stale = '1. 64 items. 2. The parser timeout is 30 seconds. 3. PARSE-7741.'
    const scored = scoreAnswer(stale)
    expect(scored.supersession).toBe(false)
    expect(scored.total).toBe(2)
  })

  it('accepts a bare correct value with no explanation', () => {
    const terse = ['1. 64', '2. 90', '3. PARSE-7741'].join(String.fromCharCode(10))
    expect(scoreAnswer(terse).total).toBe(3)
  })

  it('rejects an answer that only says unknown', () => {
    const nothing = '1. unknown 2. unknown 3. unknown'
    expect(scoreAnswer(nothing).total).toBe(0)
  })

  it('does not let a supersession mention excuse a missing 90', () => {
    // Saying "the 30 was superseded" without giving the new value is not an
    // answer, even though the clause carries a marker.
    const evasive = '1. 64 items. 2. The 30-second value was superseded. 3. PARSE-7741.'
    expect(scoreAnswer(evasive).supersession).toBe(false)
  })
})

describe.skipIf(!LIVE_ENABLED)('RC1.2-A live: the recall loop actually executes tools', () => {
  it('three arms, real tool execution, bounded rounds', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const SMOKE_WINDOW = Number(process.env.EF_LIVE_SMOKE_WINDOW ?? 6_000)
    const REPLICATES = Number(process.env.EF_LIVE_RECALL_REPLICATES ?? 3)
    const profile = flash()

    // PRODUCTION retention, and identical window/threshold/retain across arms.
    const shared = {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: Math.floor((SMOKE_WINDOW - 1_500) * 0.16),
      maxTokens: 1_500,
    }

    const arms = ['basic', 'none', 'rationale'] as const
    type Arm = (typeof arms)[number]

    const runArm = async (arm: Arm, replicate: number): Promise<{
      outcome: LoopOutcome
      folds: number
      cost: number
      calls: number
      failed: number
    }> => {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: SMOKE_WINDOW,
      })
      const recorder = new BillingRecorder(adapter, `${arm}-${replicate}`)
      // THE ARMS ARE MOUNTED MUTUALLY EXCLUSIVELY (RC1.2.1).
      //
      // The previous version passed `plugin: true` unconditionally and then
      // spread `{ engine: 'basic' }` for the Basic arm. `createHarness` returns
      // early on `plugin: true`, so that spread was DEAD CODE and the "Basic"
      // arm was really EF with the default policy plus the EF recall tools —
      // which is why it reported `facts retrievable 2/5`, a metric that is
      // undefined for real Basic. The harness now throws on that combination,
      // and this builds each arm explicitly.
      //
      // Basic is a different COMPACTION ENGINE, not a plugin configuration: it
      // has no Bundle, and `context_search` / `context_recall` do not exist for
      // it. Mounting the ToolRuntime is still correct — it is what lets a model
      // call whatever tools ARE declared — but the EF tools simply are not
      // among them.
      const harness = await createHarness({ text: 'digest' }, arm === 'basic'
        ? {
          contextWindow: SMOKE_WINDOW,
          engine: 'basic' as const,
          systemPrompt: true,
          tools: true,
          efConfig: shared,
          adapter: { provider: LIVE_PROVIDER, instance: recorder },
        }
        : {
          contextWindow: SMOKE_WINDOW,
          plugin: true,
          systemPrompt: true,
          // The ToolRuntime is what makes `context_search` / `context_recall`
          // executable. RC1.1's smoke omitted it, so the loop could not exist.
          tools: true,
          efConfig: arm === 'rationale'
            ? { ...resolvePreset('economy'), ...shared, semanticMode: 'rationale' as const }
            : { ...resolvePreset('economy'), ...shared },
          adapter: { provider: LIVE_PROVIDER, instance: recorder },
        })
      const session = seedNarrative()
      const folds = await growAndFold(harness, session, 14, 3_000)
      const outcome = await runRecallLoop(harness, session, PROBE)
      const bill = summarizeFullBill(`${arm}-${replicate}`, recorder.bill, profile)
      return {
        outcome,
        folds,
        cost: bill.cost,
        calls: recorder.bill.length,
        failed: recorder.failedCalls.length,
      }
    }

    const results: Record<Arm, Array<{ outcome: LoopOutcome; folds: number; cost: number; calls: number; failed: number }>> = {
      basic: [], none: [], rationale: [],
    }

    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const arm of arms) {
        const result = await runArm(arm, replicate)
        results[arm].push(result)
        const scored = scoreAnswer(result.outcome.answer)
        console.log(
          `RECALL rep${replicate} ${arm.padEnd(9)}: folds=${result.folds} `
          + `rounds=${result.outcome.rounds} search=${result.outcome.searchCalls} `
          + `recall=${result.outcome.recallCalls} other=${result.outcome.otherCalls} `
          + `recalledChars=${result.outcome.recalledChars} calls=${result.calls} `
          + `failed=${result.failed} cost=${result.cost.toFixed(5)} `
          + `truncated=${result.outcome.truncated} `
          + `answerScore=${JSON.stringify(scored)}`
          + (arm === 'basic'
            ? ''
            : ` toolOutputFacts=${result.outcome.toolOutputFacts.total}/3`),
        )
        console.log(`  answer: ${result.outcome.answer.replace(/\s+/gu, ' ').slice(0, 260)}`)
      }
    }

    // --- Vacuity guard: an arm that never folded measured nothing about folding.
    for (const arm of arms) {
      expect(
        results[arm].every(result => result.folds > 0),
        `${arm} must fold in every replicate`,
      ).toBe(true)
    }

    const mean = (values: readonly number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

    // --- A TRUNCATED loop is excluded from the quality tally, never scored as
    // a wrong answer. R4-E established this: an empty answer caused by the
    // harness running out of rounds is not a policy failure, and counting it as
    // one manufactures a regression.
    const completed: Record<Arm, typeof results.basic> = { basic: [], none: [], rationale: [] }
    for (const arm of arms) {
      for (const result of results[arm]) {
        if (result.outcome.truncated) {
          console.log(
            `EXCLUDED (truncated): ${arm} hit the ${MAX_ROUNDS}-round cap while still calling tools; `
            + 'its answer is incomplete, so it is not a quality observation',
          )
          continue
        }
        completed[arm].push(result)
      }
    }

    // --- THE SEPARATION. `recalledFacts` measures EF's recall mechanism;
    // `answerScore` measures the model's use of it. Reporting only the second
    // would attribute a tool-use failure to the policy.
    // --- The mechanism metric is EF-ONLY. Basic has no Bundle and no EF recall
    // tools, so "facts retrievable through EF recall" is undefined for it, and
    // reporting a number there was the error RC1.2.1 corrected.
    console.log('RETRIEVAL (EF arms only) vs ANSWER (all arms, out of 3 facts):')
    for (const arm of arms) {
      const answered = completed[arm].map(result => scoreAnswer(result.outcome.answer).total)
      if (arm === 'basic') {
        console.log(
          `  ${arm.padEnd(9)} answer [${answered.join(', ')}] | no EF recall tools: `
          + 'retrievability is undefined for Basic',
        )
        continue
      }
      const retrieved = completed[arm].map(result => result.outcome.toolOutputFacts.total)
      console.log(
        `  ${arm.padEnd(9)} tool-returned facts [${retrieved.join(', ')}] | answer [${answered.join(', ')}]`,
      )
    }

    console.log('RECALL SUMMARY (score out of 3, completed loops only):')
    for (const arm of arms) {
      const scores = completed[arm].map(result => scoreAnswer(result.outcome.answer).total)
      const searches = completed[arm].map(result => result.outcome.searchCalls)
      const recalls = completed[arm].map(result => result.outcome.recallCalls)
      console.log(
        `  ${arm.padEnd(9)} n=${scores.length} scores [${scores.join(', ')}] `
        + `mean ${scores.length === 0 ? 'n/a' : mean(scores).toFixed(2)}/3 | `
        + `search [${searches.join(', ')}] recall [${recalls.join(', ')}]`,
      )
    }

    // --- THE QUESTION: does the loop recover what the surface lost?
    const noneScores = completed.none.map(result => scoreAnswer(result.outcome.answer).total)
    const basicScores = completed.basic.map(result => scoreAnswer(result.outcome.answer).total)
    const rationaleScores = completed.rationale.map(result => scoreAnswer(result.outcome.answer).total)
    const noneMean = mean(noneScores)
    const basicMean = mean(basicScores)
    const rationaleMean = mean(rationaleScores)

    const noneSearched = results.none.some(result => result.outcome.searchCalls + result.outcome.recallCalls > 0)
    const noneRecalled = results.none.some(result => result.outcome.recalledChars > 0)

    // A tally over zero completed loops would compare nothing, so it is
    // reported rather than silently producing a 0/3.
    if (noneScores.length === 0 || basicScores.length === 0) {
      console.log(
        'RECALL INCONCLUSIVE: too few completed loops to compare. The round cap is the constraint, '
        + 'not the policy.',
      )
    }

    console.log(
      `RECALL OUTCOME: none ${noneMean.toFixed(2)}/3, basic ${basicMean.toFixed(2)}/3, `
      + `rationale ${rationaleMean.toFixed(2)}/3; none used recall tools: ${noneSearched} `
      + `(returned content: ${noneRecalled})`,
    )

    // --- THE SEPARATION, which is what RC1.2 §3's readings turn on.
    //
    // A run where recall RETURNED the facts and the model then answered badly is
    // not the same finding as a run where recall returned nothing. The first is a
    // model tool-use outcome; the second would be an EF mechanism failure. Only
    // the second would justify changing the preset.
    const efArms = arms.filter(arm => arm !== 'basic')
    const retrieved = (arm: Arm): number[] =>
      completed[arm].map(result => result.outcome.toolOutputFacts.total)
    const mechanismRecovered = efArms.map(arm => ({
      arm,
      runs: retrieved(arm).length,
      recovered: retrieved(arm).filter(score => score > 0).length,
      best: retrieved(arm).length === 0 ? 0 : Math.max(...retrieved(arm)),
    }))
    for (const entry of mechanismRecovered) {
      console.log(
        `RECALL MECHANISM ${entry.arm.padEnd(9)}: a tool returned facts in `
        + `${entry.recovered}/${entry.runs} completed run(s); best ${entry.best}/3`,
      )
    }

    // --- RC1.2 §3's readings, stated explicitly so the report cannot pick a
    // flattering one afterwards.
    const mechanismWorks = mechanismRecovered.every(entry => entry.recovered > 0)
    if (noneScores.length === 0 || basicScores.length === 0) {
      console.log('RC1.2 INCONCLUSIVE: too few completed loops to compare.')
    } else if (noneMean >= basicMean) {
      console.log(
        'RC1.2 OUTCOME A: economy-none matches Basic once recall is available. The RC1.1 '
        + '"conditional on declaration" reading was TOO STRONG; the contract is "declared state is '
        + 'hot, undeclared history is recoverable through bounded recall".',
      )
    } else if (mechanismWorks) {
      // The distinction that decides whether the preset is at fault.
      console.log(
        'RC1.2 OUTCOME A (mechanism works, residual gap is tool use): recall RETURNS the folded facts in every arm, and the residual '
        + 'answer-score gap is MODEL TOOL USE, not the EF mechanism. A generic economy preset is '
        + 'not shown to need rationale by this evidence — the mechanism it relies on works.',
      )
    } else {
      console.log(
        'RC1.2 OUTCOME B/C: recall did not return the facts in at least one arm. That is a mechanism '
        + 'finding and would justify changing the preset; it needs a larger sample to confirm.',
      )
    }

    // The assertion records the OUTCOME rather than a pass/fail on a policy: all
    // three are legitimate findings, and the test's job is to establish which.
    expect(noneScores.length).toBe(REPLICATES)
    expect(basicScores.length).toBe(REPLICATES)
    // Whatever the outcome, the loop must have been genuinely available to the
    // economy arm — otherwise the result describes the harness, not the policy.
    expect(
      results.none.every(result => result.outcome.providerCalls > 0),
      'the economy arm must have made model calls',
    ).toBe(true)
  }, 2_400_000)
})
