/**
 * R33.1-A: the global budget at the real HTTP-attempt boundary.
 *
 * R33 charged one `stream()` call. The adapter retries a 429 internally, so one
 * `stream()` could be three HTTP requests and the ledger saw one. These tests
 * drive the REAL `OpenAiCompatibleAdapter` against a local mock provider and
 * assert on the requests the server actually received.
 *
 * No credential, no network, no provider: `fetchImpl` is the local server.
 *
 * @module tests/r331-budget-http
 */

import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BudgetLedger } from '../eval/r33/src/budget.mjs'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'

interface Step {
  readonly status: number
  readonly usage?: Record<string, unknown>
}

async function mockProvider(script: readonly Step[]) {
  let count = 0
  const bodies: unknown[] = []
  const server = createServer(async (request, response) => {
    const index = count
    count += 1
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    try {
      bodies.push(JSON.parse(raw))
    } catch {
      bodies.push(raw)
    }
    const step = script[Math.min(index, script.length - 1)]!
    if (step.status === 429) {
      response.writeHead(429, { 'retry-after': '0', 'content-type': 'text/plain' })
      response.end('rate limited')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      ...(step.usage === undefined ? {} : { usage: step.usage }),
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    bodies,
    attempts: () => count,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function ledgerWith(requests: number) {
  return new BudgetLedger({
    requests,
    inputTokens: 2_000_000,
    outputTokens: 100_000,
    wallClockMs: 60_000,
  })
}

async function streamOnce(adapter: OpenAiCompatibleAdapter) {
  const chunks: any[] = []
  for await (const chunk of adapter.stream({
    provider: 'test',
    model: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxTokens: 16,
  } as any)) {
    chunks.push(chunk)
  }
  return chunks
}

function adapterFor(port: number, ledger: BudgetLedger) {
  return new OpenAiCompatibleAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'mock-key-not-a-credential',
    model: 'test',
    budget: ledger as any,
    fetchImpl: fetch,
  })
}

describe('R33.1 attempt-level budget', () => {
  it('charges each of 429, 429, 200 as a separate HTTP attempt', async () => {
    const provider = await mockProvider([
      { status: 429 },
      { status: 429 },
      { status: 200, usage: { prompt_tokens: 12, completion_tokens: 4 } },
    ])
    try {
      const ledger = ledgerWith(10)
      const before = ledger.snapshot()
      const adapter = adapterFor(provider.port, ledger)
      const chunks = await streamOnce(adapter)
      const after = ledger.snapshot()
      expect(provider.attempts()).toBe(3)
      expect(after.used.requests).toBe(3)
      expect(after.observed.inputTokens).toBe(12)
      expect(after.observed.outputTokens).toBe(4)
      // A 429 produced no generation, but its cost is unknown, not zero:
      // both throttled attempts keep their conservative reserve and are
      // counted as unknown usage.
      expect(after.unknownUsageRequests).toBe(2)
      expect(after.reserved.outputTokens).toBe(2 * 16)
      expect(after.reserved.inputTokens).toBe(2 * 131_072)
      expect(after.unresolvedAttempts).toBe(2)
      expect(after.charged.outputTokens).toBe(4 + 2 * 16)
      expect(adapter.rateLimitTelemetry).toEqual({ retries: 2, exhausted: 0 })
      expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop')).toBe(true)
      // The before snapshot is a point in time, not an alias of the ledger.
      expect(before.used.requests).toBe(0)
      expect(before.observed.inputTokens).toBe(0)
    } finally {
      await provider.close()
    }
  })

  it('does NOT send a third request when the budget admits only two', async () => {
    const provider = await mockProvider([
      { status: 429 },
      { status: 429 },
      { status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ])
    try {
      const ledger = ledgerWith(2)
      const adapter = adapterFor(provider.port, ledger)
      const chunks = await streamOnce(adapter)
      const after = ledger.snapshot()
      expect(provider.attempts()).toBe(2)
      expect(provider.bodies).toHaveLength(2)
      expect(after.used.requests).toBe(2)
      expect(after.refusals).toBe(1)
      expect(after.unknownUsageRequests).toBe(2)
      expect(after.reserved.outputTokens).toBe(2 * 16)
      const finish: any = chunks.find(chunk => chunk.type === 'finish')
      expect(finish?.reason.kind).toBe('error')
      expect(finish?.reason.failure.code).toBe('BUDGET_EXHAUSTED')
    } finally {
      await provider.close()
    }
  })

  it('does not settle an unreported output dimension to zero', async () => {
    const provider = await mockProvider([
      { status: 200, usage: { prompt_tokens: 10 } },
    ])
    try {
      const ledger = ledgerWith(10)
      const adapter = adapterFor(provider.port, ledger)
      await streamOnce(adapter)
      const after = ledger.snapshot()
      expect(provider.attempts()).toBe(1)
      expect(after.observed.inputTokens).toBe(10)
      expect(after.observed.outputTokens).toBe(0)
      // The provider did not report completion tokens, so the output reserve
      // stands. Reporting 0 would make an unknown cost look free.
      expect(after.reserved.outputTokens).toBe(16)
      expect(after.partialUsageRequests).toBe(1)
      expect(after.charged.outputTokens).toBe(16)
    } finally {
      await provider.close()
    }
  })

  it('keeps the full reserve when the provider reports no usage at all', async () => {
    const provider = await mockProvider([{ status: 200 }])
    try {
      const ledger = ledgerWith(10)
      const adapter = adapterFor(provider.port, ledger)
      await streamOnce(adapter)
      const after = ledger.snapshot()
      expect(after.observed.inputTokens).toBe(0)
      expect(after.observed.outputTokens).toBe(0)
      expect(after.unknownUsageRequests).toBe(1)
      expect(after.reserved.outputTokens).toBe(16)
      expect(after.reserved.inputTokens).toBeGreaterThan(0)
      expect(after.charged.inputTokens).toBe(after.reserved.inputTokens)
    } finally {
      await provider.close()
    }
  })
})
