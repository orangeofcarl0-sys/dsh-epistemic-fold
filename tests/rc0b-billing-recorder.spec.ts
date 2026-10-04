/**
 * RC0-B: the all-call billing recorder.
 *
 * R4-D's RBCR came from real provider counters but was collected by the
 * BENCHMARK calling `adapter.stream()` with a hand-built single-user-message
 * request. Two consequences made the number weaker than its name:
 *
 * 1. It was not the agent's wire shape — no system prompt, no tool schemas, no
 *    real role structure — and the R3 framing saving is earned THROUGH that
 *    assembly.
 * 2. It recorded only main requests, so **Basic's `purpose: 'compaction'`
 *    summary call was omitted**, understating Basic's bill and overstating how
 *    much cheaper EF is.
 *
 * The recorder is a decorator at the LLM seam, so the agent loop drives
 * everything as it does in production and every call is captured with its
 * purpose. These tests pin the recorder's contract and the aggregation; the
 * live tier exercises it end to end.
 */

import { describe, expect, it } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BillingRecorder, classifyPurpose, isBillable } from '../eval/live/recorder.ts'
import { fullBillToMarkdown, fullTaskRbcr, summarizeFullBill } from '../eval/live/billing.ts'
import type { RequestBill } from '../eval/live/billing.ts'
import { flash } from './economics-fixture.ts'

/** A scripted inner adapter, so the recorder is testable without a provider. */
class ScriptedAdapter extends LlmAdapter {
  constructor(
    private readonly responses: readonly {
      readonly usage?: { input: number; cacheRead?: number; output: number }
      readonly fail?: string
    }[],
  ) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 131_072 } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = Number((options as { marker?: number }).marker ?? 0)
    const response = this.responses[Math.min(index, this.responses.length - 1)]!
    if (response.fail !== undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: response.fail, code: 'X' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    if (response.usage !== undefined) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          ...(response.usage.cacheRead === undefined ? {} : { cacheReadTokens: response.usage.cacheRead }),
        },
      }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Drain one adapter call with the given options. */
async function drain(adapter: LlmAdapter, options: Partial<GenerateOptions> & { marker?: number }): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: 'p', model: 'm', messages: [], ...options,
  } as never)) {
    void _chunk
  }
}

describe('RC0-B: the recorder is a pass-through decorator', () => {
  it('forwards every chunk unchanged', async () => {
    // Wrapping must not change what the agent sees, or the measurement would
    // be of a different system than the one that ships.
    const inner = new ScriptedAdapter([{ usage: { input: 10, output: 5 } }])
    const recorder = new BillingRecorder(inner, 'E4')
    const seen: string[] = []
    for await (const chunk of recorder.stream({ provider: 'p', model: 'm', messages: [] } as never)) {
      seen.push(chunk.type)
    }
    expect(seen).toEqual(['block-start', 'block-end', 'usage', 'finish'])
  })

  it('delegates resolveModel so the agent loop still routes', async () => {
    const recorder = new BillingRecorder(new ScriptedAdapter([{}]), 'E4')
    const info = await recorder.resolveModel('p', 'm')
    expect(info.context?.contextWindow).toBe(131_072)
  })

  it('records provider counters verbatim', async () => {
    const inner = new ScriptedAdapter([{ usage: { input: 100, cacheRead: 900, output: 42 } }])
    const recorder = new BillingRecorder(inner, 'E4')
    await drain(recorder, { marker: 0 })
    const [call] = recorder.bill
    expect(call!.uncachedInputTokens).toBe(100)
    expect(call!.cacheReadTokens).toBe(900)
    expect(call!.outputTokens).toBe(42)
    // promptTokens is the sum the provider charged for, and it is the
    // denominator of the realization rate.
    expect(call!.promptTokens).toBe(1000)
    expect(call!.success).toBe(true)
  })
})

describe('RC0-B: every call is captured with its purpose', () => {
  it('classifies DSH purposes and defaults an unmarked call to main', () => {
    expect(classifyPurpose({ purpose: 'compaction' } as never)).toBe('compaction')
    expect(classifyPurpose({ purpose: 'session-title' } as never)).toBe('other')
    // The agent loop issues main requests WITHOUT a purpose marker, so an
    // unmarked call is main — not "unknown".
    expect(classifyPurpose({} as never)).toBe('main')
  })

  it('captures a compaction call alongside main calls', async () => {
    // The specific omission RC0-B fixes: Basic's fold makes a real compaction
    // call that costs money, and R4-D never recorded it.
    const inner = new ScriptedAdapter([
      { usage: { input: 1_000, cacheRead: 0, output: 100 } },
      { usage: { input: 5_000, cacheRead: 0, output: 200 } },
    ])
    const recorder = new BillingRecorder(inner, 'B1')
    await drain(recorder, { marker: 0 })
    await drain(recorder, { marker: 1, purpose: 'compaction' })
    const purposes = recorder.bill.map(call => call.purpose)
    expect(purposes).toEqual(['main', 'compaction'])
  })

  it('records a FAILED attempt rather than dropping it', async () => {
    // A transport failure consumed a real request. Excluding it would understate
    // the cost of the arm that needed the retry.
    const inner = new ScriptedAdapter([{ fail: 'transport down' }, { usage: { input: 10, output: 5 } }])
    const recorder = new BillingRecorder(inner, 'E4')
    await drain(recorder, { marker: 0 })
    await drain(recorder, { marker: 1 })
    expect(recorder.bill).toHaveLength(2)
    expect(recorder.bill[0]!.success).toBe(false)
    expect(recorder.failedCalls).toHaveLength(1)
    expect(recorder.bill[1]!.success).toBe(true)
  })

  it('attributes a retry to the call it retried', async () => {
    const inner = new ScriptedAdapter([{ fail: 'transport down' }, { usage: { input: 10, output: 5 } }])
    const recorder = new BillingRecorder(inner, 'E4')
    await drain(recorder, { marker: 0 })
    const failedId = recorder.bill[0]!.callId
    recorder.markNextAsRetryOf(failedId)
    await drain(recorder, { marker: 1 })
    expect(recorder.bill[1]!.retryOf).toBe(failedId)
    // The marker is one-shot: a later call is not a retry of it.
    await drain(recorder, { marker: 1 })
    expect(recorder.bill[2]!.retryOf).toBeUndefined()
  })

  it('records the request class so realization can be split (R4 §24)', async () => {
    const inner = new ScriptedAdapter([{ usage: { input: 10, cacheRead: 0, output: 5 } }])
    const recorder = new BillingRecorder(inner, 'E4')
    recorder.markNextRequest('after-leaf')
    await drain(recorder, { marker: 0 })
    expect(recorder.bill[0]!.requestClass).toBe('after-leaf')
    // One-shot: the next call is normal again.
    await drain(recorder, { marker: 0 })
    expect(recorder.bill[1]!.requestClass).toBe('normal')
  })

  it('knows which calls were billable', async () => {
    const inner = new ScriptedAdapter([{ fail: 'down' }])
    const recorder = new BillingRecorder(inner, 'E4')
    await drain(recorder, { marker: 0 })
    // A failure that produced no usage cost nothing, and is reported as such
    // rather than being assigned a fabricated cost.
    expect(isBillable(recorder.bill[0]!)).toBe(false)
  })
})

describe('RC0-B: FullTaskRBCR prices ALL calls, split by purpose', () => {
  const bill = (overrides: Partial<RequestBill>): RequestBill => ({
    uncachedInputTokens: overrides.uncachedInputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    ...(overrides.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: overrides.cacheWriteTokens }),
    promptTokens: overrides.promptTokens
      ?? (overrides.uncachedInputTokens ?? 0) + (overrides.cacheReadTokens ?? 0),
    requestClass: overrides.requestClass ?? 'normal',
    ...(overrides.purpose === undefined ? {} : { purpose: overrides.purpose }),
  })

  it('includes compaction calls, which the main-only metric omitted', () => {
    // The consequence the audit predicted: adding Basic's compaction cost makes
    // EF look BETTER, not worse, because the omitted term was Basic's.
    const profile = flash()
    const basicMainOnly: RequestBill[] = [bill({ uncachedInputTokens: 1_000_000 })]
    const basicWithCompaction: RequestBill[] = [
      ...basicMainOnly,
      bill({ uncachedInputTokens: 1_000_000, purpose: 'compaction' }),
    ]
    const economy: RequestBill[] = [bill({ uncachedInputTokens: 500_000 }), bill({ uncachedInputTokens: 500_000 })]

    const mainOnly = summarizeFullBill('B1', basicMainOnly, profile)
    const full = summarizeFullBill('B1', basicWithCompaction, profile)
    expect(full.cost).toBeCloseTo(mainOnly.cost * 2, 9)

    const rbcrMainOnly = fullTaskRbcr(summarizeFullBill('E4', economy, profile), mainOnly)!
    const rbcrFull = fullTaskRbcr(summarizeFullBill('E4', economy, profile), full)!
    expect(rbcrFull).toBeLessThan(rbcrMainOnly)
    console.log(`main-only RBCR ${rbcrMainOnly.toFixed(3)} -> full-task RBCR ${rbcrFull.toFixed(3)}`)
  })

  it('splits the bill by purpose so the mechanism is attributable', () => {
    const summary = summarizeFullBill('B1', [
      bill({ uncachedInputTokens: 1_000, purpose: 'main' }),
      bill({ uncachedInputTokens: 2_000, purpose: 'compaction' }),
      bill({ uncachedInputTokens: 3_000, purpose: 'compaction' }),
    ], flash())
    expect(summary.byPurpose.map(entry => entry.purpose)).toEqual(['main', 'compaction'])
    const compaction = summary.byPurpose.find(entry => entry.purpose === 'compaction')!
    expect(compaction.calls).toBe(2)
    expect(compaction.promptTokens).toBe(5_000)
    // Purposes that did not occur are omitted rather than reported as zero.
    expect(summary.byPurpose.find(entry => entry.purpose === 'rationale')).toBeUndefined()
  })

  it('charges retry cost to the same budget and reports the rate', () => {
    const summary = summarizeFullBill('E4', [
      bill({ uncachedInputTokens: 1_000 }),
      // A failed attempt that consumed nothing: recorded, costed at 0, and
      // still visible in the retry rate.
      bill({ uncachedInputTokens: 0, outputTokens: 0 }),
      bill({ uncachedInputTokens: 0, outputTokens: 0 }),
    ], flash())
    expect(summary.calls).toBe(3)
    expect(summary.failedCalls).toBe(2)
    expect(summary.retryRate).toBeCloseTo(2 / 3, 6)
    expect(summary.retryCost).toBe(0)
  })

  it('an unmarked call is priced as main, not dropped', () => {
    const summary = summarizeFullBill('E4', [bill({ uncachedInputTokens: 500 })], flash())
    expect(summary.calls).toBe(1)
    expect(summary.byPurpose[0]!.purpose).toBe('main')
  })

  it('FullTaskRBCR is undefined when Basic cost nothing', () => {
    expect(fullTaskRbcr(summarizeFullBill('E4', [], flash()), summarizeFullBill('B1', [], flash())))
      .toBeUndefined()
  })

  it('renders a purpose table for the report', () => {
    const markdown = fullBillToMarkdown(summarizeFullBill('B1', [
      bill({ uncachedInputTokens: 1_000, purpose: 'main' }),
      bill({ uncachedInputTokens: 2_000, purpose: 'compaction' }),
    ], flash()))
    expect(markdown).toContain('| main |')
    expect(markdown).toContain('| compaction |')
    expect(markdown).toContain('retry rate')
  })
})
