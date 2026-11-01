/**
 * R33-0.2: who carries a fact when the handoff deliberately does not?
 *
 * The writer instruction tells the model NOT to restate constraints, test
 * status, or other machine state in the handoff, because a machine section owns
 * them. That division of labour is only safe when the machine section actually
 * contains the fact. If the writer omits a constraint, or the validator refuses
 * one, the checkpoint can silently lose something the next agent needs — and
 * the handoff, having obeyed its instruction, will not mention it either.
 *
 * This is a CHARACTERIZATION test of the current pipeline, not a demand that it
 * be complete. It pins three things:
 *
 *  1. an accepted constraint reaches the machine section;
 *  2. an omitted proposal and a refused proposal reach NEITHER section;
 *  3. the diagnostics still say `protocol: parsed, coverage: not-assessed`,
 *     which is the honest description — parsed is not coverage.
 *
 * The measured gap is the input to a later decision (R33-D): if real tasks show
 * this losing action-critical facts, the fix is a budgeted coverage fallback,
 * not a blanket re-paste of the transcript.
 *
 * @module tests/r33-coverage
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session as DshSession, SessionId } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { registerEpistemicFoldProjection } from '../src/state/projection.ts'
import { makeTemp } from '../eval/tmp.ts'
import { MODEL, SIGNAL, createHarness, foldAgent } from './harness.ts'
import type { Harness, Session } from './harness.ts'

const GOLD = [
  'The public API must remain backward compatible in this release.',
  'All log lines must be emitted as JSON lines.',
  'Do not add any new runtime dependency without approval.',
] as const

const ACCEPTED_QUOTE = 'public API must remain backward compatible'
const FABRICATED_QUOTE = 'new runtime dependency is forbidden by the platform team'

const HANDOFF = 'The configuration loader was discussed; no machine state is repeated here.'

function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

function writerReply(): string {
  const deltas = [
    {
      kind: 'constraint',
      subjectKey: 'api-compatibility',
      statement: GOLD[0],
      status: 'claimed',
      evidence: [{ quote: ACCEPTED_QUOTE }],
    },
    {
      kind: 'constraint',
      subjectKey: 'dependencies',
      statement: GOLD[2],
      status: 'claimed',
      // Fabricated: the phrase is not in the folded span. The validator must
      // refuse this independently of whether the claim itself is true.
      evidence: [{ quote: FABRICATED_QUOTE }],
    },
  ]
  return [
    '<handoff>', HANDOFF, '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

function constraintSession(): Session {
  const session = DshSession.create(SessionId(`r33-coverage-${Date.now()}`))
  for (const [index, text] of GOLD.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Recorded. ${'padding '.repeat(240)}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: GOLD.length + 1 })
  return session as Session
}

async function fold(h: Harness, session: Session): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle!.rendered.text
}

describe('handoff / machine-state coverage', () => {
  it('shows that a partial extraction is not reported as complete coverage', async () => {
    const root = await makeTemp('ef-r33-coverage-')
    const h = await createHarness(
      { textFor: options => isWriterCall(options) ? writerReply() : 'digest' },
      {
        efConfig: {
          semanticContinuity: 'active',
          semanticMode: 'rationale',
          semanticWorkingSetTokens: 512,
          bundleRoot: join(root, 'bundles'),
          semanticRoot: join(root, 'semantic'),
        },
      },
    )
    registerEpistemicFoldProjection(h.ctx)

    const body = await fold(h, constraintSession())

    // 1. The accepted constraint is carried by the machine section.
    expect(body).toContain('public API must remain backward compatible')

    // 2. The omitted and the refused facts are absent from BOTH sections: the
    //    handoff obeyed its instruction, and no machine anchor holds them.
    expect(body).not.toContain('JSON lines')
    expect(body).not.toContain('new runtime dependency')
    expect(body.split(HANDOFF).length - 1).toBe(1)

    const observation = h.engine.semanticWriterObservation!
    expect(observation.protocol).toBe('parsed')
    expect(observation.proposed).toBe(2)
    expect(observation.accepted).toBe(1)
    expect(observation.refused).toBe(1)
    expect(observation.refusals['evidence-not-found']).toBe(1)
    // 3. The runtime does not claim to have covered the three gold facts.
    expect(observation.coverage).toBe('not-assessed')
    expect(observation.integrity).toBe('ready')

    // The gap this R33 evaluation must price:
    const visibleGold = GOLD.filter(fact => body.includes(fact.slice(0, 24)))
    expect(visibleGold).toHaveLength(1)
    expect(GOLD.length - visibleGold.length).toBe(2)
  })
})
