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

describe('an UNKNOWN-cost request is charged, never treated as free', () => {
  const RESERVE = { promptTokens: 1_000, outputTokens: 100 }

  /** A provider that answers with one fixed status and no usage. */
  function statusFetch(status: number) {
    const calls: number[] = []
    const impl = (async (): Promise<Response> => {
      calls.push(calls.length + 1)
      return new Response('nope', { status })
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  it('keeps the reserve when a sent request fails with 5xx and never reports usage', async () => {
    // The request left the process. It may have been processed and billed, and nothing local can
    // know. Charging it nothing is the defect this reservation exists to remove.
    const budget = new RequestBudget({ ...LIMITS, requests: 5 }, RESERVE)
    const fake = statusFetch(500)
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(fake.calls.length).toBe(1)
    const snapshot = budget.snapshot()
    expect(snapshot.reservedPromptTokens, 'reserved, because the cost is unknown').toBe(1_000)
    expect(snapshot.observedPromptTokens, 'nothing was measured').toBe(0)
    expect(snapshot.promptTokens, 'the CHARGED total includes the reserve').toBe(1_000)
  })

  it('settles the reserve into the measurement when usage DOES arrive', async () => {
    const budget = new RequestBudget({ ...LIMITS, requests: 5 }, RESERVE)
    const fake = scriptedFetch(['ok'], { prompt_tokens: 250, completion_tokens: 7, total_tokens: 257 })
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    const snapshot = budget.snapshot()
    expect(snapshot.reservedPromptTokens, 'the reserve is REPLACED, not added to').toBe(0)
    expect(snapshot.observedPromptTokens).toBe(250)
    expect(snapshot.promptTokens).toBe(250)
  })

  it('counts a partial usage record rather than letting it pass as a measurement', async () => {
    // `mapUsage` fills absent fields with 0, so the usage object EXISTS and an `undefined` test
    // cannot see that the output side was never reported.
    const budget = new RequestBudget({ ...LIMITS, requests: 5 }, RESERVE)
    const fake = scriptedFetch(['ok'], { prompt_tokens: 300 })
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(budget.snapshot().partialUsageRequests).toBe(1)
    expect(budget.snapshot().observedPromptTokens).toBe(300)
  })
})

describe('an UNREPORTED dimension keeps its reserve; a reported one settles', () => {
  const RESERVE = { promptTokens: 131_072, outputTokens: 131_072 }

  it('keeps the OUTPUT reserve when only input usage is reported', async () => {
    // `{prompt_tokens: 12000}` makes `mapUsage` return outputTokens: 0. Settling the whole reserve
    // would free the reply as if it had been free -- the defect this per-dimension rule removes.
    const budget = new RequestBudget({ ...LIMITS, requests: 5 }, RESERVE)
    const fake = scriptedFetch(['ok'], { prompt_tokens: 12_000 })
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    const snapshot = budget.snapshot()
    expect(snapshot.observedPromptTokens, 'the input side used the report').toBe(12_000)
    expect(snapshot.reservedPromptTokens, 'and its reserve was released').toBe(0)
    expect(snapshot.reservedOutputTokens, 'the UNREPORTED output keeps its reserve').toBe(131_072)
    expect(snapshot.partialUsageRequests).toBe(1)
  })

  it('keeps the PROMPT reserve when only output usage is reported', async () => {
    const budget = new RequestBudget({ ...LIMITS, requests: 5 }, RESERVE)
    const fake = scriptedFetch(['ok'], { completion_tokens: 400 })
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    const snapshot = budget.snapshot()
    expect(snapshot.observedOutputTokens, 'the output side used the report').toBe(400)
    expect(snapshot.reservedOutputTokens, 'and its reserve was released').toBe(0)
    expect(snapshot.reservedPromptTokens, 'the UNREPORTED prompt keeps its reserve').toBe(131_072)
  })

  it('refuses a NONSENSE value rather than settling to a smaller figure', async () => {
    const budget = new RequestBudget({ ...LIMITS, requests: 5 }, RESERVE)
    const fake = scriptedFetch(['ok'], { prompt_tokens: -1, completion_tokens: 400 })
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(budget.snapshot().reservedPromptTokens, 'a negative report is NOT a measurement').toBe(131_072)
    expect(budget.snapshot().observedPromptTokens).toBe(0)
  })
})

describe('the reservation is complete BEFORE the fetch, even with two requests in flight', () => {
  const RESERVE = { promptTokens: 131_072, outputTokens: 131_072 }

  /** A provider that answers only when the test releases it, so both requests can be in flight. */
  function deferredFetch() {
    const waiting: ((response: Response) => void)[] = []
    const calls: number[] = []
    const impl = (async (): Promise<Response> => {
      calls.push(calls.length + 1)
      return new Promise<Response>(resolve => waiting.push(resolve))
    }) as unknown as typeof fetch
    return {
      calls,
      impl,
      release: (index: number, usage?: Record<string, number>) => {
        waiting[index]!(ok(usage))
      },
    }
  }

  it('reserves for BOTH before either settles, and one settlement frees only its own', async () => {
    // The cost bound allows exactly one overshoot, which is only sound if a request cannot reach
    // the provider before its own reservation is charged. This is that check, not a restatement.
    const budget = new RequestBudget({ ...LIMITS, requests: 10 }, RESERVE)
    const fake = deferredFetch()
    const first = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    const second = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })

    const inFlight = [drive(first), drive(second)]
    while (fake.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 5))

    const both = budget.snapshot()
    expect(both.requests, 'both attempts counted').toBe(2)
    expect(both.reservedPromptTokens, 'and BOTH reserved before either fetch was answered').toBe(262_144)
    expect(both.reservedOutputTokens).toBe(262_144)

    fake.release(0, { prompt_tokens: 100, completion_tokens: 5 })
    await inFlight[0]!
    const afterOne = budget.snapshot()
    expect(afterOne.observedPromptTokens, 'the settled one became a measurement').toBe(100)
    expect(afterOne.reservedPromptTokens, "the OTHER request's reserve is untouched").toBe(131_072)
    expect(afterOne.reservedOutputTokens).toBe(131_072)

    fake.release(1, { prompt_tokens: 250, completion_tokens: 9 })
    await inFlight[1]!
    expect(budget.snapshot().reservedPromptTokens, 'and settles when it answers').toBe(0)
    expect(budget.snapshot().observedPromptTokens).toBe(350)
  })
})

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
    // Production shape: a reserve is configured, so an unmeasured response keeps it.
    const budget = new RequestBudget({ ...LIMITS, requests: 1, promptTokens: 5 }, { promptTokens: 131_072, outputTokens: 131_072 })
    const fake = scriptedFetch(['ok', 'ok'], undefined)
    const adapter = new OpenAiCompatibleAdapter({ ...BASE, fetchImpl: fake.impl, budget })
    await drive(adapter)
    expect(budget.snapshot().requests, 'the attempt counted').toBe(1)
    expect(budget.snapshot().reservedPromptTokens, 'the reserve STANDS when nothing was measured').toBe(131_072)
    expect(budget.snapshot().observedPromptTokens, 'nothing was measured, and none is invented').toBe(0)
    expect(budget.snapshot().promptTokens, 'the charged total is the reserve').toBe(131_072)
    expect(budget.snapshot().unknownUsageRequests).toBe(1)
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