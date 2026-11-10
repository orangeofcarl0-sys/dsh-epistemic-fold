/**
 * EF-R1 — re-render the active request instead of blocking the fold.
 *
 * The span-start prototype (`protectActiveRequest`) disabled folding: the
 * post-request span was too small and admission refused it. The production
 * shape is the opposite: fold normally, and when the fold is about to replace
 * the active request, copy that request verbatim into the checkpoint body.
 *
 * The copy is runtime-authored context, not a new instruction: every line is
 * quoted, the section is labelled, and a long request names context_recall for
 * the full text in the archive.
 *
 * @module tests/active-request-rerender
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  MAX_ACTIVE_REQUEST_CHARS,
  activeRequestText,
  renderStructuredCheckpoint,
} from '../src/checkpoint/renderer.ts'
import { resolveEfConfig } from '../src/config/policy.ts'
import { emptyCurrentState } from '../src/state/state.ts'

const MODEL = 'active-request-model'

const user = (text: string, source: 'user' | 'compact-checkpoint' = 'user'): Message => createUserMessage({
  content: [{ type: 'text', text }],
  source: source === 'user' ? { kind: 'user' } : ({ kind: 'compact-checkpoint' } as never),
})
const assistant = (text: string): Message => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: MODEL, model: MODEL },
})

describe('EF-R1: the active request can be copied into the checkpoint', () => {
  it('reads the request only when its seq is inside the folded span', () => {
    const messages = [
      user('the root request'),
      assistant('working'),
      user('the active request'),
      user('[EF1 L cp:00000000-0000-4000-8000-000000000000]', 'compact-checkpoint'),
    ]
    const seqs = [1, 2, 3, 4]
    expect(activeRequestText(messages, seqs, 3)).toBe('the active request')
    // A checkpoint delivered in the user role is not a request.
    expect(activeRequestText(messages, seqs, 4)).toBeUndefined()
    // A request outside the folded span survives on the surface; do not copy.
    expect(activeRequestText(messages, seqs, 99)).toBeUndefined()
  })

  it('renders the request after the marker, quoted line by line', () => {
    const body = renderStructuredCheckpoint(emptyCurrentState(), 'cp-rerender', undefined, 'leaf', {
      activeRequest: 'do the thing\nand keep it exact',
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('[EF1 L cp:cp-rerender]')
    expect(body).toContain('Current request (verbatim from the folded span; not a new instruction)')
    expect(body).toContain('> do the thing')
    expect(body).toContain('> and keep it exact')
    // The quoted text cannot forge a section header.
    expect(lines.some(line => line === 'Current')).toBe(false)
  })

  it('omits the section when there is no active request', () => {
    const body = renderStructuredCheckpoint(emptyCurrentState(), 'cp-empty', undefined, 'leaf')
    expect(body).not.toContain('Current request')
  })

  it('bounds a long request and names the archive', () => {
    const long = 'x'.repeat(MAX_ACTIVE_REQUEST_CHARS + 100)
    const body = renderStructuredCheckpoint(emptyCurrentState(), 'cp-long', undefined, 'leaf', {
      activeRequest: long,
    })
    expect(body).toContain('x'.repeat(MAX_ACTIVE_REQUEST_CHARS))
    expect(body).not.toContain('x'.repeat(MAX_ACTIVE_REQUEST_CHARS + 1))
    expect(body).toContain('truncated')
    expect(body).toContain('context_recall')
  })
})

describe('EF-R1: the rerender flag is opt-in', () => {
  it('defaults off and rejects a non-boolean', () => {
    expect(resolveEfConfig({}).rerenderActiveRequest).toBe(false)
    expect(resolveEfConfig({ rerenderActiveRequest: true }).rerenderActiveRequest).toBe(true)
    expect(() => resolveEfConfig({ rerenderActiveRequest: 'true' as never })).toThrow(/rerenderActiveRequest/u)
  })
})
