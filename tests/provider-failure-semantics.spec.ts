/**
 * A provider failure must not be reported as a model turn.
 *
 * ## The defect this exists for
 *
 * Three unrelated causes collapsed into ONE observable, and the observable was
 * attributed to the model:
 *
 *   1. HTTP 429 (rate limit)      -> `LIVE_HTTP`, no content
 *   2. `finish_reason: length`    -> `max-tokens`, no content
 *   3. the model genuinely silent -> `stop`, no content
 *
 * All three reached the LHTB agent as `content == ""`. The agent counted each
 * toward `empty_streak`, appended a fabricated "your last reply was empty"
 * message to the conversation, and ended the episode at `MAX_EMPTY_STREAK = 5`.
 * So a rate limit changed the durable session history and could terminate a task
 * — which is what made the two-pass measurement uninterpretable: pass 2 ran at a
 * 14% upstream 429 rate against pass 1's 7%, and its two `vector-db` cells died
 * after 7 and 16 model calls.
 *
 * Worse in the other direction: the agent ended a task on ANY non-empty text
 * without reading the finish reason, so a reply TRUNCATED at the token cap was
 * read as the model declaring itself finished. That ends a task silently, with no
 * anomaly recorded anywhere.
 *
 * ## The three fixes pinned here
 *
 *   - the bridge appends NOTHING to the session for a failed call, so a provider
 *     fault cannot enter the foldable surface;
 *   - the adapter retries a 429 a bounded number of times, honouring
 *     `Retry-After`, so a transient limit is not reported as a failure at all;
 *   - the agent distinguishes a provider failure from a silent model, and never
 *     reads `max-tokens` as completion.
 *
 * @module tests/provider-failure-semantics
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'

const ROOT = join(import.meta.dirname, '..')
const BRIDGE = readFileSync(join(ROOT, 'eval', 'tau2', 'bridge-host.ts'), 'utf8')
const AGENT = readFileSync(join(ROOT, 'eval', 'lhtb', 'ef_lhtb_agent.py'), 'utf8')

/** A fetch that answers with a scripted sequence of statuses. */
function scriptedFetch(statuses: readonly number[], retryAfter?: string): {
  calls: RequestInit[]
  impl: typeof fetch
} {
  const calls: RequestInit[] = []
  let index = 0
  const impl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {})
    const status = statuses[Math.min(index, statuses.length - 1)]!
    index += 1
    if (status === 429) {
      return new Response('rate limited', {
        status: 429,
        ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
      })
    }
    return new Response(JSON.stringify({
      id: 'x',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

/** Drive one request and return the finish reason it produced. */
async function finishOf(adapter: OpenAiCompatibleAdapter): Promise<string> {
  let reason = 'none'
  for await (const chunk of adapter.stream({
    provider: 'live',
    model: 'live',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 8,
  } as never)) {
    if (chunk.type === 'finish') reason = chunk.reason.kind
  }
  return reason
}

function adapter(fetchImpl: typeof fetch): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key-not-real',
    model: 'longcat-2.5-preview-free',
    fetchImpl,
  })
}

describe('the adapter retries a rate limit instead of reporting it', () => {
  it('retries a 429 and returns the successful response', async () => {
    // The whole point: a transient limit must not become a reported failure. One
    // 429 followed by a 200 is the measured shape (2-14% of calls throttled).
    const { calls, impl } = scriptedFetch([429, 200], '0')
    const reason = await finishOf(adapter(impl))
    expect(reason, 'the retry must surface the successful call, not the 429').toBe('stop')
    expect(calls.length, 'two attempts: the 429 and the retry').toBe(2)
  })

  it('honours Retry-After rather than a fixed sleep', async () => {
    // `retry-after: 0` makes the wait observable as "no wait", which is how this
    // can assert the header is read without slowing the suite. A fixed backoff
    // would still pass the previous test but fail this one.
    const { calls, impl } = scriptedFetch([429, 200], '0')
    const started = Date.now()
    await finishOf(adapter(impl))
    const elapsed = Date.now() - started
    expect(calls.length).toBe(2)
    expect(elapsed, 'Retry-After: 0 must not wait the 1s default backoff').toBeLessThan(500)
  })

  it('gives up after a bounded number of attempts, and reports the failure', async () => {
    // A provider that is genuinely down must not be retried forever: the episode
    // budget is the thing being measured. So the limit is finite and the failure
    // is reported normally once it is reached.
    const { calls, impl } = scriptedFetch([429], '0')
    const reason = await finishOf(adapter(impl))
    expect(reason, 'an exhausted rate limit is still a reported error').toBe('error')
    // 1 initial attempt + MAX_RATE_LIMIT_RETRIES (3).
    expect(calls.length, 'the retry budget must be finite').toBe(4)
  })

  it('does NOT retry a 5xx, which is a different fault', async () => {
    // Retrying a 500 would hide the outages a run needs to record, and the two
    // need separate handling. Only 429 is retried here.
    const { calls, impl } = scriptedFetch([500])
    const reason = await finishOf(adapter(impl))
    expect(reason).toBe('error')
    expect(calls.length, 'a server error is reported, not retried').toBe(1)
  })

  it('reports how much of the run was throttling', () => {
    // So a report can subtract provider load from mode quality. Without this the
    // two-pass comparison could not separate them.
    const telemetry = adapter(scriptedFetch([200]).impl).rateLimitTelemetry
    expect(telemetry).toEqual({ retries: 0, exhausted: 0 })
  })
})

describe('a failed call writes nothing into the durable surface', () => {
  it('the bridge returns before appending when the finish reason is an error', () => {
    // The order is the fix. `session.append('assistant/message', …)` used to run
    // unconditionally, so a 429 wrote an EMPTY assistant turn into the session —
    // metered, foldable, and read back to the model as its own prior output.
    const failureBranch = BRIDGE.indexOf("if (finishReason.startsWith('error:'))")
    const appendAt = BRIDGE.indexOf("session!.append('assistant/message'")
    expect(failureBranch, 'the failure branch must exist').toBeGreaterThan(-1)
    expect(appendAt, 'and the append must exist').toBeGreaterThan(-1)
    expect(failureBranch, 'the guard must come BEFORE the append').toBeLessThan(appendAt)
  })

  it('the failure branch closes the turn and returns without a surface node', () => {
    const start = BRIDGE.indexOf("if (finishReason.startsWith('error:'))")
    const end = BRIDGE.indexOf('// Record what the model said', start)
    const branch = BRIDGE.slice(start, end > 0 ? end : start + 1_200)
    // An unclosed turn is illegal, so the branch must close the one `rotateTurn`
    // opened — but it must not append an assistant message inside it.
    expect(branch, 'the turn must be closed, not left open').toMatch(/closeTurn\(\)/u)
    expect(branch, 'and no assistant message may be appended').not.toMatch(
      /session!\.append\('assistant\/message'/u,
    )
    expect(branch, 'it must return rather than fall through').toMatch(/return \{/u)
  })

  it('the reply carries the failure so the agent can tell it from a silent model', () => {
    // `content: null` alone is ambiguous, which is the entire bug. The error field
    // is what makes the two distinguishable.
    expect(BRIDGE, 'the assistant message must carry the failure').toMatch(/readonly error\?: string/u)
    expect(BRIDGE, 'and it must be set from the finish reason').toMatch(
      /lastProviderError = finishReason\.slice/u,
    )
  })

  it('reports provider failures separately from model calls', () => {
    // `modelCalls` counts calls; a failed call is not a model turn and produced
    // no surface node. Merging them is what let a throttled run read as a run
    // where the model did poorly.
    expect(BRIDGE).toMatch(/readonly providerFailures: number/u)
    expect(BRIDGE).toMatch(/readonly lastProviderError: string \| null/u)
    expect(BRIDGE, 'and they must be reset per episode').toMatch(/providerFailures = 0/u)
  })
})

describe('the agent never attributes a provider fault to the model', () => {
  it('branches on the provider error BEFORE the empty-reply handling', () => {
    // Order matters: if the empty branch ran first, a provider failure would
    // still be counted as an empty reply and still append a nudge.
    const errorBranch = AGENT.indexOf('error = reply.get("error")')
    const emptyBranch = AGENT.indexOf('if content == "" or content == EMPTY_PLACEHOLDER:')
    expect(errorBranch, 'the provider branch must exist').toBeGreaterThan(-1)
    expect(emptyBranch).toBeGreaterThan(-1)
    expect(errorBranch, 'and it must come first').toBeLessThan(emptyBranch)
  })

  it('does not append a nudge for a provider failure', () => {
    const start = AGENT.indexOf('error = reply.get("error")')
    const end = AGENT.indexOf('if not calls:', start)
    const branch = AGENT.slice(start, end > 0 ? end : start + 2_000)
    // A nudge would put a turn into the conversation because the PROVIDER was
    // busy — the exact mechanism that corrupted the history.
    expect(branch, 'no fabricated user message for a provider failure').not.toMatch(
      /self\._bridge\.append\(/u,
    )
    expect(branch, 'the failure must be recorded').toMatch(/anomaly": "provider failure"/u)
    expect(branch, 'and counted separately').toMatch(/provider_failures \+= 1/u)
  })

  it('bounds provider failures separately from the empty streak', () => {
    // A provider recovering is worth waiting for; a model that keeps saying
    // nothing is not. One ceiling cannot serve both, and conflating them is the
    // bug being fixed.
    expect(AGENT, 'a separate ceiling must exist').toMatch(/MAX_PROVIDER_FAILURES/u)
    const providerCeiling = /MAX_PROVIDER_FAILURES = int\(os\.environ\.get\([^,]+,\s*"(\d+)"\)/u
      .exec(AGENT)
    const emptyCeiling = /MAX_EMPTY_STREAK = int\(os\.environ\.get\([^,]+,\s*"(\d+)"\)/u.exec(AGENT)
    expect(providerCeiling, 'with a default').not.toBeNull()
    expect(emptyCeiling).not.toBeNull()
    expect(
      Number(providerCeiling![1]),
      'a provider outage deserves more patience than a silent model',
    ).toBeGreaterThan(Number(emptyCeiling![1]))
  })

  it('does NOT read a truncated reply as a completed task', () => {
    // The quieter misreading: `max-tokens` WITH partial text used to end the task
    // with no anomaly recorded, because the branch only checked for emptiness.
    const truncated = AGENT.indexOf('if finish.endswith("max-tokens"):')
    const completion = AGENT.indexOf('termination = "model-reported-completion"')
    expect(truncated, 'the truncation branch must exist').toBeGreaterThan(-1)
    expect(completion).toBeGreaterThan(-1)
    expect(truncated, 'and it must be checked before declaring completion').toBeLessThan(completion)
    const branch = AGENT.slice(truncated, completion)
    expect(branch, 'it must be recorded as an anomaly').toMatch(/anomaly": "truncated response"/u)
    expect(branch, 'and continue rather than break').toMatch(/continue/u)
  })
})

describe("the episode's termination reason is recorded", () => {
  it('is written into the transcript, so a reward is attributable', () => {
    // A reward of 0 says nothing about WHY, and the container is deleted. So
    // "died after 7 model calls" was previously unattributable from the archive,
    // and no rerun of the collector could recover it.
    expect(AGENT, 'the reason must be tracked').toMatch(/termination = "turn-budget-exhausted"/u)
    expect(AGENT, 'and every exit path must set it').toMatch(/termination = f?"/u)
    expect(AGENT, 'it must reach the transcript payload').toMatch(/"termination": termination/u)
    expect(AGENT, 'and the run metadata').toMatch(/"ef_termination": termination/u)
  })

  it('bumps the transcript schema, so an older reader skips rather than misreads', () => {
    expect(AGENT).toMatch(/"schema": "ef-lhtb-transcript\/3"/u)
  })

  it('the collector reads both new fields, and marks them MISSING when absent', () => {
    const collector = readFileSync(join(ROOT, 'scripts', 'ef-collect.py'), 'utf8')
    expect(collector, 'termination must be read').toMatch(/row\["termination"\] = payload\.get/u)
    expect(collector, 'provider failures must be read').toMatch(/row\["providerFailures"\]/u)
    expect(
      collector,
      'a missing field must be MISSING, never a defaulted zero',
    ).toMatch(/"MISSING" if provider is None else provider/u)
  })
})
