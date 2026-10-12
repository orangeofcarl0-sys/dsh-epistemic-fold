/**
 * The provider rejects an unbalanced tool shape, and one bad history poisons the episode.
 *
 * Measured against https://opencode.ai/zen/go/v1 with deepseek-v4.1-flash:
 *
 *   2 tool_calls, 2 answers            -> 200
 *   1 tool_call,  0 answers            -> 400 invalid_request_error
 *   3 tool_calls, 2 answers            -> 400
 *   2 tool_calls, answers OUT OF ORDER -> 200
 *   a tool result naming an uncalled id -> 400
 *
 * Order does not matter and the CONTENT does not matter -- NUL bytes, lone surrogates and 200KB of
 * output all returned 200. The SHAPE is what is rejected.
 *
 * It matters because the failure is self-perpetuating: once the history holds an unanswered
 * tool_call, every later request in that episode is malformed, so the cell stops dead while Harbor
 * reports the trial as running and the container stays Up. It was observed as 13 provider failures
 * in 23 calls followed by no progress at all, and it is model-independent.
 *
 * @module tests/live-tool-shape
 */

import { describe, expect, it } from 'vitest'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'

/** Capture the request body the adapter sends, and answer with a minimal completion. */
function capture(): { bodies: Record<string, unknown>[]; impl: typeof fetch } {
  const bodies: Record<string, unknown>[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { bodies, impl }
}

const adapter = (impl: typeof fetch) => new OpenAiCompatibleAdapter({
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'test-key-not-real',
  model: 'deepseek-v4.1-flash',
  fetchImpl: impl,
})

const text = (t: string) => [{ type: 'text', text: t }]
const call = (id: string) => ({ type: 'tool-call', id, name: 'run_shell', arguments: '{}' })

/** Every tool_call id in the sent body must have exactly one matching tool result. */
function shape(body: Record<string, unknown>): { called: string[]; answered: string[] } {
  const msgs = body.messages as Record<string, unknown>[]
  const called: string[] = []
  const answered: string[] = []
  for (const m of msgs) {
    const calls = m.tool_calls as { id?: string }[] | undefined
    if (Array.isArray(calls)) for (const c of calls) if (c.id !== undefined) called.push(c.id)
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') answered.push(m.tool_call_id)
  }
  return { called, answered }
}

async function send(impl: typeof fetch, messages: unknown[]): Promise<void> {
  const a = adapter(impl)
  for await (const _ of a.stream({ messages, system: undefined } as never)) { /* drain */ }
}

describe('the adapter never sends an unbalanced tool shape', () => {
  it('fills an unanswered tool_call rather than sending it', async () => {
    const { bodies, impl } = capture()
    await send(impl, [
      { role: 'user', content: text('go') },
      { role: 'assistant', content: [call('c1'), call('c2')] },
      { role: 'tool', toolCallId: 'c1', content: text('a') },
    ])
    const { called, answered } = shape(bodies[0]!)
    expect(called).toEqual(['c1', 'c2'])
    expect([...answered].sort()).toEqual(['c1', 'c2'])
  })

  it('drops a tool result that names an id never called', async () => {
    const { bodies, impl } = capture()
    await send(impl, [
      { role: 'user', content: text('go') },
      { role: 'tool', toolCallId: 'ghost', content: text('a') },
    ])
    expect(shape(bodies[0]!).answered).toEqual([])
  })

  it('leaves a balanced shape untouched', async () => {
    const { bodies, impl } = capture()
    await send(impl, [
      { role: 'user', content: text('go') },
      { role: 'assistant', content: [call('c1')] },
      { role: 'tool', toolCallId: 'c1', content: text('a') },
    ])
    const { called, answered } = shape(bodies[0]!)
    expect(called).toEqual(['c1'])
    expect(answered).toEqual(['c1'])
    expect(JSON.stringify(bodies[0])).not.toContain('no result was recorded')
  })

  it('marks a synthesised result as synthesised', async () => {
    const { bodies, impl } = capture()
    await send(impl, [
      { role: 'user', content: text('go') },
      { role: 'assistant', content: [call('c1')] },
    ])
    expect(JSON.stringify(bodies[0])).toContain('no result was recorded')
  })
})
