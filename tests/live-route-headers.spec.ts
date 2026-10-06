/**
 * Route-required headers, and the one thing they must not be able to do.
 *
 * ## Why this exists
 *
 * `https://opencode.ai/zen/go/v1` answers `400 MissingSessionID` — "cannot be
 * routed efficiently" — on EVERY call without an `x-opencode-session` header,
 * where the sibling `/zen/v1` route does not ask for one. That is a property of
 * the route, so it travels with the route (`LiveRoute.headers`, from
 * `EF_LIVE_HEADERS`) rather than being rebuilt at each of the three call sites.
 *
 * A missing or misspelled header makes every model call fail, and a run whose
 * every model call fails reads as a provider fault rather than as a typo — the
 * same trap as the `error:fetch failed` that `docs/50` §2.1 records. So a
 * malformed `EF_LIVE_HEADERS` is an ERROR, not a silent no-op, and that is
 * pinned here.
 *
 * ## The guard that matters
 *
 * The headers are spread BEFORE `content-type` and `authorization`, so a route
 * can add a requirement but cannot name its way into replacing the credential.
 * The last test here is the destructive one: it sets `EF_LIVE_HEADERS` to a JSON
 * object containing `authorization` and asserts the real bearer token still wins.
 *
 * @module tests/live-route-headers
 */

import { describe, expect, it } from 'vitest'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'

const KEYS = ['EF_LIVE_BASE_URL', 'EF_LIVE_API_KEY', 'EF_LIVE_HEADERS', 'EF_LIVE_MODEL'] as const

/** Run `body` with exactly the listed live-route env, restoring afterwards. */
function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, body: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const key of KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key as (typeof KEYS)[number]] = value
  }
  try {
    body()
  } finally {
    for (const key of KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const ROUTE = {
  EF_LIVE_BASE_URL: 'https://opencode.ai/zen/go/v1',
  EF_LIVE_API_KEY: 'test-key-not-real',
}

/** One in-memory response, so the request can be inspected without a network. */
function fakeFetch(): { calls: RequestInit[]; impl: typeof fetch } {
  const calls: RequestInit[] = []
  const impl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {})
    return new Response(JSON.stringify({
      id: 'x',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

async function drain(adapter: OpenAiCompatibleAdapter): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: 'live',
    model: 'live',
    // DSH's request shape: content is a list of blocks, not a bare string.
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 8,
  } as never)) {
    // Consumed only to drive the request.
  }
}

describe('route-required headers travel with the route', () => {
  it('parses EF_LIVE_HEADERS onto the resolved route', () => {
    withEnv({ ...ROUTE, EF_LIVE_HEADERS: '{"x-opencode-session":"abc123"}' }, () => {
      const route = resolveLiveRoute()
      expect(route?.headers).toEqual({ 'x-opencode-session': 'abc123' })
    })
  })

  it('omits headers entirely when EF_LIVE_HEADERS is absent', () => {
    withEnv(ROUTE, () => {
      expect(resolveLiveRoute()?.headers).toBeUndefined()
    })
  })

  it('REJECTS malformed JSON rather than ignoring it', () => {
    // The whole point: a route that needs a header and does not get one fails
    // every call, and that must not be reachable by a silent no-op.
    withEnv({ ...ROUTE, EF_LIVE_HEADERS: 'not json' }, () => {
      expect(() => resolveLiveRoute()).toThrow(/not valid JSON/u)
    })
  })

  it('rejects a non-object and a non-string value', () => {
    withEnv({ ...ROUTE, EF_LIVE_HEADERS: '["array"]' }, () => {
      expect(() => resolveLiveRoute()).toThrow(/must be a JSON object/u)
    })
    withEnv({ ...ROUTE, EF_LIVE_HEADERS: '{"x-opencode-session":7}' }, () => {
      expect(() => resolveLiveRoute()).toThrow(/must be a string/u)
    })
  })

  it('sends the route headers on the request', async () => {
    const { calls, impl } = fakeFetch()
    await drain(new OpenAiCompatibleAdapter({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'test-key-not-real',
      model: 'longcat-2.5-preview-free',
      headers: { 'x-opencode-session': 'abc123' },
      fetchImpl: impl,
    }))
    const sent = calls[0]?.headers as Record<string, string>
    expect(sent['x-opencode-session']).toBe('abc123')
    expect(sent.authorization).toBe('Bearer test-key-not-real')
  })

  it('lets a route ADD a header but never REPLACE the credential', async () => {
    // The destructive guard. If the spread order were reversed, this assignment
    // would be the one that reached the wire.
    const { calls, impl } = fakeFetch()
    await drain(new OpenAiCompatibleAdapter({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'test-key-not-real',
      model: 'longcat-2.5-preview-free',
      headers: { authorization: 'Bearer attacker', 'content-type': 'text/plain' },
      fetchImpl: impl,
    }))
    const sent = calls[0]?.headers as Record<string, string>
    expect(sent.authorization, 'the real credential must win').toBe('Bearer test-key-not-real')
    expect(sent['content-type'], 'the adapter controls the content type').toBe('application/json')
  })
})
