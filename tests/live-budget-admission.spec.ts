/**
 * The budget gate must REFUSE, and the refusal must be measured, not asserted from source text.
 *
 * Every test here drives the REAL `OpenAiCompatibleAdapter` against a counting fake fetch. The
 * count is the evidence: a gate that merely has an `admit()` method proves nothing about how many
 * requests actually left.
 *
 * @module tests/live-budget-admission
 */

import { describe, expect, it } from 'vitest'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { RequestBudget, budgetLimitsFromEnv, parseBudgetLimit } from '../eval/live/request-budget.ts'

const BASE = {
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test-key-not-real',
  model: 'test-model',
}

const LIMITS = { requests: 0, promptTokens: 0, outputTokens: 0, wallClockMs: 0 }

function ok(usage: Record<string, number> | undefined): Response {
  return new Response(JSON.stringify({
    id: 'x',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    ...(usage === undefined ? {} : { usage }),
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A fake provider whose statuses are scripted, counting every attempt it is asked to make. */
function scriptedFetch(script: ('ok' | '429')[], usage?: Record<string, number>) {
  const calls: number[] = []
  const impl = (async (): Promise<Response> => {
    const step = script[calls.length] ?? 'ok'
    calls.push(calls.length + 1)
    if (step === '429') return new Response('rate limited', { status: 429 })
    return ok(usage)
  }) as unknown as typeof fetch
  return { calls, impl }
}

interface Failure { readonly code?: string }

/** Drive one request and return the finish reason it produced, if any. */
async function drive(
  adapter: OpenAiCompatibleAdapter,
): Promise<{ failure?: Failure; kind?: string; usage?: unknown }> {
  let failure: Failure | undefined
  let kind: string | undefined
  let usage: unknown
  for await (const chunk of adapter.stream({
    provider: 'live',
    model: 'live',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 8,
  } as never)) {
    const any = chunk as { type?: string; reason?: { kind?: string; failure?: Failure }; usage?: unknown }
    if (any.type === 'finish') { kind = any.reason?.kind; failure = any.reason?.failure }
    if (any.type === 'usage') usage = any.usage
  }
  return { ...(failure === undefined ? {} : { failure }), ...(kind === undefined ? {} : { kind }), ...(usage === undefined ? {} : { usage }) }
}

describe('the budget gate refuses BEFORE the request leaves', () => {
  it('admits the first request and refuses the second, with fetch called exactly once', async () => {
    const budget = new RequestBudget({ ...LIMITS, requests: 1 })
    const fake = scriptedFetch(['ok', 'ok'])
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(fake.calls.length, 'the first request really left').toBe(1)
    const second = await drive(adapter)
    expect(fake.calls.length, 'the refused request did NOT leave').toBe(1)
    expect(second.failure?.code).toBe('BUDGET_EXHAUSTED')
    expect(budget.snapshot().refusals).toBe(1)
  })

  it('does not let a 429 retry past a request limit of one', async () => {
    const budget = new RequestBudget({ ...LIMITS, requests: 1 })
    const fake = scriptedFetch(['429', 'ok'])
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    const result = await drive(adapter)
    expect(fake.calls.length, 'the retry was refused, not sent').toBe(1)
    // A retry is a real request, and its refusal is a BUDGET stop -- never reported as the 429.
    expect(result.failure?.code).toBe('BUDGET_EXHAUSTED')
  })

  it('lets the retry through when the limit allows two, and counts both', async () => {
    const budget = new RequestBudget({ ...LIMITS, requests: 2 })
    const fake = scriptedFetch(['429', 'ok'])
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    const result = await drive(adapter)
    expect(fake.calls.length, 'attempt + retry').toBe(2)
    expect(result.failure, 'the retry succeeded').toBeUndefined()
    expect(budget.snapshot().requests).toBe(2)
  })
})

describe('token limits are OBSERVED-consumption limits, and say so', () => {
  it('refuses the next request once reported prompt tokens reach the cap', async () => {
    const budget = new RequestBudget({ ...LIMITS, promptTokens: 100 })
    const fake = scriptedFetch(['ok', 'ok'], { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 })
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(budget.snapshot().promptTokens).toBe(100)
    const second = await drive(adapter)
    expect(second.failure?.code).toBe('BUDGET_EXHAUSTED')
    expect(fake.calls.length).toBe(1)
  })

  it('still counts the request when the provider reports NO usage', async () => {
    // Usage is missing, so the token figures are an ESTIMATE -- but a conservative one, and the
    // request cap is exact because `admit` counted the attempt regardless.
    const budget = new RequestBudget({ ...LIMITS, requests: 1, promptTokens: 5 })
    const fake = scriptedFetch(['ok', 'ok'], undefined)
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(budget.snapshot().requests, 'the attempt counted').toBe(1)
    // CONSERVATIVE, not zero: a full context window is charged for a response that reported no
    // usage, because the provider will bill for it and the request cap alone does not bound cost.
    expect(budget.snapshot().promptTokens, 'unknown is charged at the window, not as zero').toBe(131_072)
    const second = await drive(adapter)
    expect(second.failure?.code, 'the REQUEST cap still holds').toBe('BUDGET_EXHAUSTED')
  })
})

describe('a budget variable that is set but invalid is an ERROR, never a silent disable', () => {
  it('treats unset as disabled and rejects empty, NaN, negative and fractional values', () => {
    expect(parseBudgetLimit('X', {}), 'unset keeps the old lane behaviour').toBe(0)
    expect(() => parseBudgetLimit('X', { X: '' })).toThrow(/empty/u)
    expect(() => parseBudgetLimit('X', { X: 'abc' })).toThrow(/non-negative integer/u)
    expect(() => parseBudgetLimit('X', { X: '-5' })).toThrow(/non-negative integer/u)
    expect(() => parseBudgetLimit('X', { X: '1.5' })).toThrow(/non-negative integer/u)
    expect(parseBudgetLimit('X', { X: '140' })).toBe(140)
  })

  it('refuses a run that ASKED for enforcement and did not get all of it', () => {
    expect(() => budgetLimitsFromEnv({
      EF_LHTB_BUDGET_REQUIRED: '1',
      EF_LHTB_BUDGET_REQUESTS: '140',
    })).toThrow(/disabled/u)
    expect(budgetLimitsFromEnv({
      EF_LHTB_BUDGET_REQUIRED: '1',
      EF_LHTB_BUDGET_REQUESTS: '140',
      EF_LHTB_BUDGET_PROMPT_TOKENS: '7000000',
      EF_LHTB_BUDGET_OUTPUT_TOKENS: '100000',
      EF_LHTB_BUDGET_WALL_MS: '5400000',
    })).toEqual({ requests: 140, promptTokens: 7_000_000, outputTokens: 100_000, wallClockMs: 5_400_000 })
  })
})