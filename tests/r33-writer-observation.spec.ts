/**
 * R33-0.1: the writer's four independent observations.
 *
 * R32 reported `writerHealthValue = 'ready'` immediately after parsing, so a
 * response with no `<deltas>` block, a malformed block, and a complete
 * extraction all looked identical. These tests pin the separation:
 *
 *   call       success | failed | not-attempted
 *   protocol   parsed | absent | malformed | not-called
 *   deltas     proposed / accepted / refused / limitExceeded
 *   integrity  ready | partial | unavailable | conflict
 *
 * and pin that `coverage` is never claimed: `protocol: parsed` is not evidence
 * that every action-critical fact was extracted.
 *
 * @module tests/r33-writer-observation
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { observeWriter } from '../src/semantic/observation.ts'
import type { WriterObservation } from '../src/semantic/observation.ts'
import type { SemanticRefusal } from '../src/semantic/types.ts'
import { makeTemp } from '../eval/tmp.ts'
import { registerEpistemicFoldProjection } from '../src/state/projection.ts'
import { MODEL, SIGNAL, createHarness, conversation, foldAgent } from './harness.ts'
import type { Harness, Session } from './harness.ts'

const CONSTRAINT = 'The public API must remain backward compatible in this release.'
const CONSTRAINT_QUOTE = 'public API must remain backward compatible'

function refusal(reason: SemanticRefusal['reason'], index = 0): SemanticRefusal {
  return { index, reason, detail: `test refusal ${reason}` }
}

describe('observeWriter: orthogonal axes', () => {
  it('reports parsed-empty as ready without claiming coverage', () => {
    const observed = observeWriter({ call: 'success', proposed: 0, accepted: [], refused: [] })
    expect(observed).toMatchObject({
      call: 'success',
      protocol: 'parsed',
      proposed: 0,
      accepted: 0,
      refused: 0,
      limitExceeded: 0,
      integrity: 'ready',
      coverage: 'not-assessed',
    })
    expect(observed.detail).toBeUndefined()
  })

  it('reports an absent protocol as partial, not ready', () => {
    const observed = observeWriter({
      call: 'success',
      protocol: 'absent',
      detail: 'no <deltas> block in the response',
    })
    expect(observed.integrity).toBe('partial')
    expect(observed.protocol).toBe('absent')
    expect(observed.detail).toContain('<deltas>')
  })

  it('reports a malformed protocol as partial', () => {
    const observed = observeWriter({
      call: 'success',
      protocol: 'malformed',
      detail: 'deltas block is not JSON',
    })
    expect(observed.integrity).toBe('partial')
  })

  it('reports a failed call with no protocol attempt', () => {
    const observed = observeWriter({ call: 'failed', detail: 'provider refused' })
    expect(observed).toMatchObject({ call: 'failed', protocol: 'not-called', integrity: 'partial' })
  })

  it('counts limit-exceeded separately from other refusals without degrading integrity', () => {
    const observed = observeWriter({
      call: 'success',
      proposed: 14,
      accepted: new Array(12).fill({}),
      refused: [refusal('limit-exceeded', 12), refusal('limit-exceeded', 13)],
    })
    expect(observed.limitExceeded).toBe(2)
    expect(observed.refused).toBe(2)
    expect(observed.accepted).toBe(12)
    // The protocol parsed; the limit is a DELTA fact, not a writer failure.
    expect(observed.integrity).toBe('ready')
  })

  it('does not let a conflict be masked by a successful call', () => {
    const observed = observeWriter({ call: 'success', conflict: true, detail: 'journal conflict' })
    expect(observed.integrity).toBe('conflict')
  })

  it('does not let unavailable be masked by parsed deltas', () => {
    const observed = observeWriter({ call: 'success', unavailable: true, accepted: [{}] })
    expect(observed.integrity).toBe('unavailable')
  })
})

function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

async function writerHarness(reply: string): Promise<Harness> {
  const root = await makeTemp('ef-r33-observe-')
  const h = await createHarness(
    { textFor: options => isWriterCall(options) ? reply : 'digest' },
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
  return h
}

async function foldSession(h: Harness, session: Session): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle!.rendered.text
}

/** One user constraint plus enough assistant filler for the shrink check. */
function constraintSession(): Session {
  // `conversation(2)` leaves turn 3 open; append INTO it rather than opening a
  // second turn 3 (the R32 fork harness bug, in miniature).
  const session = conversation(2)
  const turn = 3
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: CONSTRAINT }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `Acknowledged. ${'padding '.repeat(300)}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turn + 1 })
  return session
}

function deltas(count: number): readonly unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'constraint',
    subjectKey: `api-${index}`,
    statement: `Constraint ${index}: ${CONSTRAINT}`,
    status: 'claimed',
    evidence: [{ quote: CONSTRAINT_QUOTE }],
  }))
}

function reply(handoff: string, proposed: readonly unknown[] | undefined): string {
  return proposed === undefined
    ? `<handoff>\n${handoff}\n</handoff>`
    : `<handoff>\n${handoff}\n</handoff>\n<deltas>\n${JSON.stringify({ deltas: proposed })}\n</deltas>`
}

describe('engine diagnostics: the writer observation reaches the status surface', () => {
  it('keeps a parsed empty delta list ready and says coverage is not assessed', async () => {
    const h = await writerHarness(reply('Nothing to record.', []))
    await foldSession(h, constraintSession())
    const observation = h.engine.semanticWriterObservation as WriterObservation
    expect(observation).toMatchObject({
      call: 'success',
      protocol: 'parsed',
      proposed: 0,
      accepted: 0,
      refused: 0,
      integrity: 'ready',
      coverage: 'not-assessed',
    })
    expect(h.engine.semanticDiagnostics.writer).toEqual(observation)
    expect(h.engine.semanticDiagnostics.health).toBe('ready')
  })

  it('reports a missing deltas block as an absent protocol, not a ready writer', async () => {
    const h = await writerHarness(reply('The handoff survives.', undefined))
    await foldSession(h, constraintSession())
    const observation = h.engine.semanticWriterObservation!
    expect(observation.protocol).toBe('absent')
    expect(observation.integrity).toBe('partial')
    expect(observation.coverage).toBe('not-assessed')
    expect(h.engine.semanticDiagnostics.health).toBe('partial')
    expect(h.engine.semanticDiagnostics.detail).toContain('<deltas>')
  })

  it('reports malformed JSON as malformed while still committing the checkpoint', async () => {
    const h = await writerHarness(
      '<handoff>The handoff survives.</handoff>\n<deltas>{not json</deltas>',
    )
    const body = await foldSession(h, constraintSession())
    const observation = h.engine.semanticWriterObservation!
    expect(observation.protocol).toBe('malformed')
    expect(observation.integrity).toBe('partial')
    expect(body.length).toBeGreaterThan(0)
    // The fold committed: protocol damage is not a checkpoint failure.
    expect(h.engine.lastSemanticPacket?.status).toBe('staged')
  })

  it('reports the per-fold limit as a delta fact and never claims completeness', async () => {
    const h = await writerHarness(reply('Twelve proposals survive.', deltas(14)))
    await foldSession(h, constraintSession())
    const observation = h.engine.semanticWriterObservation!
    expect(observation.protocol).toBe('parsed')
    expect(observation.proposed).toBe(14)
    expect(observation.accepted).toBe(12)
    expect(observation.refused).toBe(2)
    expect(observation.limitExceeded).toBe(2)
    expect(observation.integrity).toBe('ready')
    expect(observation.coverage).toBe('not-assessed')
    expect(observation.detail).toContain('limit')
  })
})
