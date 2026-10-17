/**
 * A summarization the provider truncated is RETRIED, not abandoned.
 *
 * ## The defect this exists for
 *
 * Basic fails a fold closed when its checkpoint call finishes `max-tokens`:
 * "summarization truncated at the token cap (incomplete checkpoint)". Failing closed
 * is right -- a half-written checkpoint must not land as if it were complete -- but it
 * is not the only right answer, because the call is RECOVERABLE. On a reasoning model
 * the cap is spent on reasoning AND content together, so the same input truncated at
 * every budget from 2048 to 16384 while the model wrote more than eight thousand
 * tokens of summary. In round 3b that cost the `basic` arm eight folds across three
 * `unknown-config-semantics` cells, and every one of them was recorded as a
 * `compactionFailureKinds.truncated` rather than as a fold.
 *
 * ## What is pinned, and at which level
 *
 * The POLICY is pinned as arithmetic (`summaryRetryBudget`), because the property that
 * matters is that a retry spends MORE than the attempt it replaces -- a retry at the
 * same budget reproduces the constraint that truncated it.
 *
 * The WIRING is pinned through the engine and the real fold path, using the harness's
 * scripted semantic face to truncate the first attempt and answer the next. That is
 * the assertion the arithmetic test cannot make: that the retry is reached at all, and
 * that the SUCCESS path still makes exactly one call.
 *
 * @module tests/summary-retry
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHarness, MODEL, SIGNAL } from './harness.ts'
import { readSrcModule } from './src-module.ts'
import type { SemanticFace } from './harness.ts'
import {
  isTruncationFailure,
  resetSummaryRetryStats,
  summaryRetryBudget,
  summaryRetryPolicy,
  summaryRetryStats,
} from '../src/summary-retry.ts'

const ROOT = join(import.meta.dirname, '..')

/** The Phase 7 error text verbatim, so the retry cannot change what is reported. */
const TRUNCATED = 'summarization truncated at the token cap (incomplete checkpoint)'

/** A conversation large enough to cross the fold threshold at an 8k context window. */
function largeConversation(turns = 12): Session {
  const session = Session.create(SessionId('summary-retry-' + turns + '-' + Math.random()))
  const blob = 'x'.repeat(4_000)
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: blob + ' user ' + turn }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blob + ' assistant ' + turn }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** The fold-driving agent the containment spec uses, so both drive the same edge. */
function agentFor(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
  } as never
}

type Foldable = {
  compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
}

/** Basic mode over an 8k window with a 2000-token summarization budget. */
const BASIC = {
  auto: true,
  thresholdRatio: 0.5,
  headroomTokens: 0,
  maxTokens: 2_000,
  mode: 'basic',
} as const

beforeEach(() => { resetSummaryRetryStats() })
afterEach(() => {
  delete process.env.EF_SUMMARY_RETRY_ATTEMPTS
  delete process.env.EF_SUMMARY_RETRY_CEILING
  resetSummaryRetryStats()
})

describe('the retry budget escalates rather than repeating', () => {
  it('doubles per attempt, so a retry spends more than the attempt it replaces', () => {
    // The whole point: repeating at the same budget reproduces the constraint that
    // truncated the reply, so it is not a retry, it is a second failure.
    const ceiling = 131_072
    expect(summaryRetryBudget(2_000, 0, ceiling)).toBe(2_000)
    expect(summaryRetryBudget(2_000, 1, ceiling)).toBe(4_000)
    expect(summaryRetryBudget(2_000, 2, ceiling)).toBe(8_000)
  })

  it('clamps at the ceiling', () => {
    expect(summaryRetryBudget(100_000, 1, 131_072)).toBe(131_072)
    expect(summaryRetryBudget(100_000, 4, 131_072)).toBe(131_072)
  })

  it('never SHRINKS a budget the caller asked for', () => {
    // A ceiling below the configured budget must not quietly narrow the first call:
    // "bounded" is a cap on the retry, not a rewrite of the request.
    expect(summaryRetryBudget(200_000, 0, 131_072)).toBe(200_000)
    expect(summaryRetryBudget(200_000, 1, 131_072)).toBe(200_000)
  })

  it('defaults to two extra attempts under a 131072 ceiling', () => {
    expect(summaryRetryPolicy()).toEqual({ extraAttempts: 2, ceiling: 131_072 })
  })

  it('reads the environment, and falls back per field on a malformed value', () => {
    process.env.EF_SUMMARY_RETRY_ATTEMPTS = '1'
    process.env.EF_SUMMARY_RETRY_CEILING = '50000'
    expect(summaryRetryPolicy()).toEqual({ extraAttempts: 1, ceiling: 50_000 })
    // One bad value must not take the other with it.
    process.env.EF_SUMMARY_RETRY_ATTEMPTS = 'nonsense'
    process.env.EF_SUMMARY_RETRY_CEILING = '-1'
    expect(summaryRetryPolicy()).toEqual({ extraAttempts: 2, ceiling: 131_072 })
  })

  it('recognizes the truncation failure structurally before matching prose', () => {
    const tagged = Object.assign(new Error('whatever'), { code: 'MAX_TOKENS' })
    expect(isTruncationFailure(tagged)).toBe(true)
    // The fallback, for an error that crossed a process boundary.
    expect(isTruncationFailure(new Error(TRUNCATED))).toBe(true)
    expect(isTruncationFailure(new Error('provider HTTP 429'))).toBe(false)
    expect(isTruncationFailure(undefined)).toBe(false)
    expect(isTruncationFailure('summarization truncated at the token cap')).toBe(false)
  })
})

describe('the engine retries a truncated summarization', () => {
  it('answers the fold on the retry and records the escalation', async () => {
    let attempt = 0
    const face: SemanticFace = { text: 'checkpoint body' }
    face.failure = { kind: 'max-tokens', message: 'truncated' }
    // The harness calls `mutate` as the stream starts, before it reads `failure`,
    // so this is where a scripted per-attempt outcome is expressed.
    face.mutate = () => {
      attempt += 1
      // `delete`, not `= undefined`: `exactOptionalPropertyTypes` distinguishes the two.
      if (attempt > 1) delete face.failure
    }
    const { engine, control } = await createHarness(face, { contextWindow: 8_000, efConfig: BASIC })

    await (engine as unknown as Foldable)
      .compactIfNeeded(agentFor(largeConversation()), 'pressure', SIGNAL)

    expect(control.calls.length, 'the fold must retry exactly once').toBe(2)
    expect(control.calls[0]!.options.maxTokens, 'the first attempt is the configured budget').toBe(2_000)
    expect(control.calls[1]!.options.maxTokens, 'the retry escalates').toBe(4_000)
    expect(summaryRetryStats.attempts).toBe(2)
    expect(summaryRetryStats.retries).toBe(1)
    expect(summaryRetryStats.escalations).toBe(1)
    expect(summaryRetryStats.exhausted).toBe(0)
  })

  it('still fails closed when EVERY attempt truncates, and says so', async () => {
    // The half-written checkpoint must not land. Retrying must not become
    // "eventually accept the partial text".
    const face: SemanticFace = {
      text: 'partial checkpoint that was cut off',
      failure: { kind: 'max-tokens', message: 'truncated' },
    }
    const { engine, control } = await createHarness(face, { contextWindow: 8_000, efConfig: BASIC })

    await expect((engine as unknown as Foldable)
      .compactIfNeeded(agentFor(largeConversation()), 'pressure', SIGNAL))
      .rejects.toThrow(/summarization truncated at the token cap/u)

    expect(control.calls.map(call => call.options.maxTokens)).toEqual([2_000, 4_000, 8_000])
    expect(summaryRetryStats.exhausted, 'an exhausted retry is recorded').toBe(1)
    expect(summaryRetryStats.retries).toBe(2)
  })

  it('honours `EF_SUMMARY_RETRY_ATTEMPTS=0` as "do not retry"', async () => {
    // The knob has to be able to restore the old behaviour, or the fix cannot be
    // measured against it.
    process.env.EF_SUMMARY_RETRY_ATTEMPTS = '0'
    const face: SemanticFace = {
      text: 'partial',
      failure: { kind: 'max-tokens', message: 'truncated' },
    }
    const { engine, control } = await createHarness(face, { contextWindow: 8_000, efConfig: BASIC })

    await expect((engine as unknown as Foldable)
      .compactIfNeeded(agentFor(largeConversation()), 'pressure', SIGNAL))
      .rejects.toThrow(/summarization truncated at the token cap/u)

    expect(control.calls.length, 'attempt zero only').toBe(1)
    expect(summaryRetryStats.retries).toBe(0)
    expect(summaryRetryStats.exhausted).toBe(1)
  })

  it('does NOT retry a cancelled fold, because the deadline that aborted it is still running', async () => {
    const controller = new AbortController()
    const face: SemanticFace = {
      text: 'partial',
      failure: { kind: 'max-tokens', message: 'truncated' },
    }
    // Abort while the first attempt is in flight: the truncation that follows is
    // then a consequence of the cancellation, not a provider fault to retry.
    face.mutate = () => { controller.abort() }
    const { engine, control } = await createHarness(face, { contextWindow: 8_000, efConfig: BASIC })

    await expect((engine as unknown as Foldable)
      .compactIfNeeded(agentFor(largeConversation()), 'pressure', controller.signal))
      .rejects.toThrow()

    expect(control.calls.length, 'a cancelled call must not be retried').toBe(1)
    expect(summaryRetryStats.retries).toBe(0)
  })

  it('makes exactly ONE call when nothing truncates, so the success path is unchanged', async () => {
    // Attempt zero is Basic's own `super.summarize` call, unmodified. If the retry
    // machinery had been placed in front of it, every fold would pay for it.
    const { engine, control } = await createHarness(
      { text: 'a complete checkpoint body' },
      { contextWindow: 8_000, efConfig: BASIC },
    )

    await (engine as unknown as Foldable)
      .compactIfNeeded(agentFor(largeConversation()), 'pressure', SIGNAL)

    expect(control.calls.length).toBe(1)
    expect(summaryRetryStats.attempts).toBe(1)
    expect(summaryRetryStats.retries).toBe(0)
  })
})

describe('where the retry must NOT live', () => {
  it('leaves the vendored Basic copy alone', () => {
    // `src/basic` is regenerated from upstream by `scripts/vendor-basic.mjs` and its
    // drift test fails on any edit that is not a declared seam edit. Putting the
    // retry there would either be silently reverted by the next regeneration or
    // would have to be smuggled into the framing seam, which is about framing.
    const vendored = readFileSync(join(ROOT, 'src', 'basic', 'summarizer.ts'), 'utf8')
    expect(vendored, 'the retry belongs in EF code, not in the vendored copy').not.toMatch(/retry/iu)
  })

  it('routes the `basic` arm through the retry, so no arm is scored for a provider artefact', () => {
    const source = readSrcModule('engine.ts')
    expect(source).toContain(
      'if (this.isBasic()) return await this.summarizeWithTruncationRetry(input, agent, signal)',
    )
    expect(source).toContain('private async summarizeWithTruncationRetry(')
    // And the first attempt is still Basic's own call.
    expect(source).toMatch(/attempt === 0\s*\n\s*\? await super\.summarize\(input, agent, signal\)/u)
  })
})
