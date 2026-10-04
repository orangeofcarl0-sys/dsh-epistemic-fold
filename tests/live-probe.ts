/**
 * The probe helpers the live behavioral suites share.
 *
 * Four suites ask a model a question about a folded surface and score the
 * answer. The request shape, the prompt and the surface rendering must be
 * IDENTICAL across them, or a difference between two suites' scores is a
 * difference in the harness rather than in the policy under test — which is
 * precisely the comparison R1/R2/R3-F/R4-E exist to make. They were four copies.
 *
 * R4-E's `ask` deliberately does NOT come from here: it retries and reports the
 * transport failure separately, because a degraded provider must not be scored
 * as a wrong answer.
 *
 * @module tests/live-probe
 */

import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import type { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { LIVE_PROVIDER } from './live-gate.ts'

/** Ask one probe through the live adapter and return the trimmed answer. */
export async function ask(adapter: OpenAiCompatibleAdapter, prompt: string): Promise<string> {
  const parts: string[] = []
  for await (const chunk of adapter.stream({
    provider: LIVE_PROVIDER,
    model: 'live',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 60,
  } as never)) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
  }
  return parts.join('').trim()
}

/**
 * All model-visible surface text.
 *
 * Used to REPORT whether planted phrasing is still present, never as a
 * pass/fail gate: a summary legitimately quoting the source text is not a
 * defect, and gating on it would fail a correct fold. The load-bearing check is
 * whether the fold removed content at all.
 */
export function surfaceText(session: SessionType): string {
  const parts: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    parts.push(message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  }
  return parts.join('\n')
}

/**
 * Build the post-fold probe prompt: the checkpoint surface plus the question.
 *
 * Rendered with the role prefix the model sees, because a probe that reads the
 * surface differently from the request would measure the probe.
 */
export function probePrompt(session: SessionType, probe: string): string {
  const lines: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .filter(part => part.length > 0)
      .join('\n')
    if (text.length === 0) continue
    lines.push(`[${message.role}] ${text}`)
  }
  lines.push(`[user] ${probe}`)
  return lines.join('\n\n')
}
