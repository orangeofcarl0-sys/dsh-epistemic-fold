/**
 * R32-C4: the whole checkpoint's capacity, not only the carried state.
 *
 * `WorkingSet.overflow === false` only says the CARRIED section fits its budget.
 * The changed delta, rationale, marker and framing can still push the complete
 * body far past any sensible handoff size. These tests price every section and
 * assert that an over-budget checkpoint reports it WITHOUT silently trimming a
 * pinned contract.
 *
 * @module tests/r32-capacity
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { renderTemporalCheckpoint } from '../src/checkpoint/renderer.ts'
import {
  compileWorkingSet,
  measureCheckpointCapacity,
} from '../src/semantic/working-set-compiler.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'
import {
  SIGNAL,
  createHarness,
  foldAgent,
  type Harness,
  type Session,
} from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'

function anchor(input: {
  readonly id: string
  readonly kind: Anchor['kind']
  readonly key: string
  readonly value: string
  readonly seq?: number
}): Anchor {
  return {
    id: input.id,
    kind: input.kind,
    stateKey: { namespace: 'semantic', entity: input.kind, property: input.key },
    value: input.value,
    authority: input.kind === 'constraint' ? 'normative' : 'decision',
    lifecycle: 'active',
    sourceRefs: [{ seq: SessionSeq(input.seq ?? 1) }],
  }
}

function crowdedState(): FoldCurrentState {
  let state = emptyCurrentState()
  for (let index = 0; index < 30; index += 1) {
    const next = anchor({
      id: `constraint-${index}`,
      kind: 'constraint',
      key: `rule-${index}`,
      value: `Constraint ${index}: the public API must not change in this release.`,
      seq: 1,
    })
    state = {
      ...state,
      constraints: { ...state.constraints, [next.id!]: next },
      stateHeads: { ...state.stateHeads, [`semantic/constraint/rule-${index}`]: next },
    }
  }
  for (let index = 0; index < 20; index += 1) {
    const next = anchor({
      id: `decision-${index}`,
      kind: 'decision',
      key: `choice-${index}`,
      value: `Decision ${index}: a working note that may be retrieved later.`,
      seq: 2,
    })
    state = {
      ...state,
      decisions: { ...state.decisions, [next.id!]: next },
      stateHeads: { ...state.stateHeads, [`semantic/decision/choice-${index}`]: next },
    }
  }
  return state
}

describe('R32-C4: complete-checkpoint capacity is observable', () => {
  it('reports pinned overflow but keeps every pinned line in the body', () => {
    const state = crowdedState()
    const compiled = compileWorkingSet({ state, budgetTokens: 128 })
    expect(compiled.overflow).toBe(true)
    expect(compiled.estimateBasis).toBe('chars-per-4')
    expect(compiled.pinned).toHaveLength(30)
    expect(compiled.omitted.length).toBeGreaterThan(0)
    for (let index = 0; index < 30; index += 1) {
      expect(compiled.text).toContain(`Constraint ${index}:`)
    }
  })

  it('prices changed, carried, rationale, framing and the joined total separately', () => {
    const state = crowdedState()
    const compiled = compileWorkingSet({ state, budgetTokens: 128 })
    const changed = [
      anchor({ id: 'changed-1', kind: 'constraint', key: 'changed', value: 'Changed this fold: the timeout is 45 seconds.', seq: 3 }),
    ]
    const capacity = measureCheckpointCapacity({
      checkpointId: 'cp-capacity',
      mode: 'leaf',
      changed,
      workingSetText: compiled.text,
      rationale: 'We changed the timeout after a measurement.',
      workingSet: compiled,
      totalBudgetTokens: 256,
    })
    expect(capacity.changedTokens).toBeGreaterThan(0)
    expect(capacity.carriedTokens).toBeGreaterThan(0)
    expect(capacity.rationaleTokens).toBeGreaterThan(0)
    expect(capacity.framingTokens).toBeGreaterThan(0)
    expect(capacity.pinnedTokens).toBeGreaterThan(0)
    expect(capacity.pinnedOverflow).toBe(true)
    expect(capacity.totalOverflow).toBe(true)
    expect(capacity.estimateBasis).toBe('chars-per-4')

    const rendered = renderTemporalCheckpoint({
      checkpointId: 'cp-capacity',
      mode: 'leaf',
      changed,
      workingSetText: compiled.text,
      rationale: 'We changed the timeout after a measurement.',
    })
    expect(capacity.totalCheckpointTokens).toBe(Math.ceil(rendered.length / 4))
  })
})

function writerReply(handoff: string, deltas: readonly unknown[]): string {
  return [
    '<handoff>', handoff, '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

function isWriterCall(options: {
  readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[]
}): boolean {
  const last = options.messages[options.messages.length - 1]
  return last?.content.some(block =>
    block.type === 'text' && block.text?.startsWith('You are the SEMANTIC WRITER')) === true
}

async function foldOpen(h: Harness, session: Session): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle?.rendered.text ?? ''
}

describe('R32-C4: an engine fold reports its whole-body overrun', () => {
  it('marks the body over budget, keeps all pinned constraints, and stays recoverable', async () => {
    const root = await makeTemp('ef-r32-capacity-')
    const box = { text: writerReply('start', []) }
    const h = await createHarness(
      { textFor: options => isWriterCall(options) ? box.text : 'digest' },
      {
        plugin: true,
        systemPrompt: true,
        efConfig: {
          auto: false,
          bundleRoot: join(root, 'bundles'),
          semanticRoot: join(root, 'semantic'),
          semanticContinuity: 'active',
          semanticMode: 'rationale',
          semanticWorkingSetTokens: 128,
          semanticCheckpointTokens: 512,
        },
      },
    )
    const session = h.ctx.sessions.create(SessionId(`capacity-${randomUUID()}`), {
      meta: { cwd: root },
    })
    const padding = ` ${'binding context padding '.repeat(120)}`
    for (let turn = 1; turn <= 2; turn += 1) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `Phase ${turn}: fixture constraint source ${turn}.${padding}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `Acknowledged phase ${turn}.${padding}` }],
          source: { kind: 'model', provider: 'test-model', model: 'test-model' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: 3 })

    const deltas = Array.from({ length: 30 }, (_, index) => ({
      kind: 'constraint',
      subjectKey: `rule-${index}`,
      statement: `Rule ${index}: the public API must not change in this release; this is a binding user constraint.`,
      status: 'claimed',
      evidence: [{ quote: 'Phase 1: fixture constraint source 1.' }],
    }))
    box.text = writerReply('A dense fold with many binding constraints.', deltas)
    const body = await foldOpen(h, session)

    const report = h.engine.lastWorkingSet
    expect(report).toBeDefined()
    if (report === undefined) return
    expect(report.totalBudgetTokens).toBe(512)
    expect(report.totalCheckpointTokens).toBeGreaterThan(512)
    expect(report.totalOverflow).toBe(true)
    // This fold's constraints are CHANGED, not carried: they belong to the
    // unbudgeted delta section, and the whole-body budget is what must catch
    // them. The direct compiler test above covers the carried-pinned case.
    expect(report.changedTokens).toBeGreaterThan(0)
    expect(report.rationaleTokens).toBeGreaterThan(0)
    expect(report.framingTokens).toBeGreaterThan(0)
    expect(report.estimateBasis).toBe('token-meter')
    expect(body).toContain('checkpoint-over-budget')
    // Every accepted constraint is visible. The writer protocol caps one fold
    // at DEFAULT_MAX_DELTAS, so the assertion is over what was ACCEPTED, not
    // over the number proposed.
    const accepted = h.engine.lastSemanticPacket?.accepted ?? []
    expect(accepted.length).toBeGreaterThan(0)
    for (const delta of accepted) expect(body).toContain(delta.statement)
    // The fold still committed, so the archive/recall path is intact.
    expect(h.engine.publishedBundle).toBeDefined()
    expect(h.engine.semanticDiagnostics.health).toBe('ready')
  }, 60_000)
})
