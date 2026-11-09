/**
 * EF-R1 pre-fix probe. Prints the observable outcome of each path without
 * asserting either behaviour, so the SAME file can be run before and after the
 * fix and the two outputs compared.
 *
 * Not part of the shipped suite; removed after the evidence capture.
 */

import { it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { validateDeltas } from '../src/semantic/validate.ts'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { FoldCurrentState } from '../src/state/state.ts'

const user = (text: string): Message => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const model = (text: string): Message => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'test', model: 'test' },
})
const tool = (text: string): Message => createToolResultMessage({
  callId: ToolCallId('call-1'),
  content: [{ type: 'text', text }],
  isError: false,
})

function fold(
  proposed: readonly Record<string, unknown>[],
  messages: readonly Message[],
  state: FoldCurrentState = emptyCurrentState(),
) {
  const foldedSeqs = messages.map((_, index) => index + 1)
  const validation = validateDeltas({ foldedSeqs, messages, proposed })
  const plan = planCommit(validation.accepted, { state })
  return { validation, plan, state: applyOps(state, plan.ops) }
}

const decision = (
  quote: string,
  statement: string,
  options: { subjectKey?: string; supersedes?: readonly string[] } = {},
): Record<string, unknown> => ({
  kind: 'decision',
  subjectKey: options.subjectKey ?? 'queue',
  statement,
  status: 'claimed',
  evidence: [{ quote }],
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})

function base() {
  const first = fold([decision('Use the in-memory queue for now.', 'Use the in-memory queue.')], [
    user('Use the in-memory queue for now.'),
  ])
  return { state: first.state, anchorId: first.plan.planned[0]!.anchorId! }
}

function observe(name: string, run: { plan: ReturnType<typeof planCommit>; state: FoldCurrentState }) {
  const active = Object.values(run.state.decisions)
    .filter(anchor => anchor.lifecycle === 'active')
    .map(anchor => ({ value: anchor.value, source: anchor.sourceAuthority ?? null }))
  process.stdout.write(`PROBE ${JSON.stringify({
    name,
    withheld: run.plan.withheld.map(entry => entry.reason),
    refused: run.plan.refusedRetirements.map(entry => entry.reason),
    declares: run.plan.ops.filter(op => op.op === 'declare').length,
    superseded: Object.keys(run.state.superseded),
    active,
  })}\n`)
}

it('probe: four authority paths', () => {
  const a = base()
  observe('no-supersedes', fold([
    decision('I decided the durable outbox is better.', 'Use the durable outbox.'),
  ], [user('Use the in-memory queue for now.'), model('I decided the durable outbox is better.')], a.state))

  const b = fold([
    decision('Use the in-memory queue for now.', 'Use the in-memory queue.'),
    decision('Use the file cache for now.', 'Use the file cache.', { subjectKey: 'cache' }),
  ], [user('Use the in-memory queue for now.'), user('Use the file cache for now.')])
  observe('unrelated-supersedes', fold([
    decision('I decided the durable outbox is better.', 'Use the durable outbox.', { supersedes: ['cache'] }),
  ], [
    user('Use the in-memory queue for now.'),
    user('Use the file cache for now.'),
    model('I decided the durable outbox is better.'),
  ], b.state))

  const c = base()
  observe('mixed-assistant-tool', fold([
    {
      kind: 'decision',
      subjectKey: 'queue',
      statement: 'Use the durable outbox.',
      status: 'claimed',
      evidence: [{ quote: 'I decided the durable outbox is better.' }, { quote: 'outbox probe returned 28 events' }],
      supersedes: ['previous'],
    },
  ], [
    user('Use the in-memory queue for now.'),
    model('I decided the durable outbox is better.'),
    tool('outbox probe returned 28 events'),
  ], c.state))

  const d = base()
  observe('old-user-quote', fold([
    {
      kind: 'decision',
      subjectKey: 'queue',
      statement: 'Use the durable outbox.',
      status: 'claimed',
      evidence: [{ quote: 'Use the in-memory queue for now.' }],
      supersedes: ['previous'],
    },
  ], [user('Use the in-memory queue for now.'), model('I decided the durable outbox is better.')], d.state))
})
