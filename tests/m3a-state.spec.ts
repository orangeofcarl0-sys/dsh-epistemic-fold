/**
 * M3a suite: deterministic current state. S01–S08 from the test spec, plus
 * the authority rules that keep narrative out of the state machine.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { canVerify } from '../src/authority.ts'
import {
  authorityLossRate,
  emptyCurrentState,
  stateKeyText,
  stateStalenessRate,
} from '../src/state.ts'
import type { Anchor, EventRef, StateKey } from '../src/state.ts'
import { registerEpistemicFoldProjection, currentFoldState } from '../src/projection.ts'
import { renderStructuredCheckpoint } from '../src/renderer.ts'
import {
  conversation,
  createHarness,
  foldAgent,
  SIGNAL,
  toolConversation,
  type Session,
} from './harness.ts'

let anchorCounter = 0

/** Build one active anchor with full provenance. */
function anchor(options: {
  kind: Anchor['kind']
  stateKey?: StateKey
  value: unknown
  authority: Anchor['authority']
  sourceRefs: readonly EventRef[]
  failureState?: Anchor['failureState']
}): Anchor {
  anchorCounter += 1
  return {
    id: `anchor-${anchorCounter}`,
    kind: options.kind,
    ...(options.stateKey === undefined ? {} : { stateKey: options.stateKey }),
    value: options.value,
    authority: options.authority,
    lifecycle: 'active',
    ...(options.failureState === undefined ? {} : { failureState: options.failureState }),
    sourceRefs: [...options.sourceRefs],
  }
}

function declare(session: Session, built: Anchor): void {
  session.append('ef/anchor', { op: 'declare', anchor: built })
}

function transition(session: Session, anchorId: string, failureState: Anchor['failureState'], evidenceRefs?: readonly EventRef[]): void {
  session.append('ef/anchor', {
    op: 'transition',
    anchorId,
    ...(failureState === undefined ? {} : { failureState }),
    ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
  })
}

/** A user turn followed by a user message, returning the message event seq. */
function appendUserText(session: Session, turn: number, text: string): number {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session.seq - 1
}

const MOUNT = { efConfig: {} }

describe('S01–S03: constraint survival, poisoning, supersession', () => {
  it('S01: explicit user constraint survives multiple leaf folds (ALR=0)', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' }, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = conversation(2)

    // Turn 3: the user states a binding constraint.
    const seq = appendUserText(session, 3, 'Do not change public API.')
    declare(session, anchor({
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'public-api' },
      value: 'Do not change public API.',
      authority: 'normative',
      sourceRefs: [{ seq: seq as never }],
    }))

    // Two leaf folds happen; the constraint is on the open trajectory at
    // first-fold time, then lives inside checkpoints.
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)

    const state = currentFoldState(ctx, session)
    const constraint = Object.values(state.constraints)[0]
    expect(constraint).toBeDefined()
    expect(constraint!.lifecycle).toBe('active')
    expect(constraint!.authority).toBe('normative')
    expect(constraint!.value).toBe('Do not change public API.')
    expect(authorityLossRate([constraint!.id], state)).toBe(0)
  })

  it('S02: summary poisoning — narrative cannot flip a failed tool state', async () => {
    const { engine, ctx } = await createHarness({ text: 'ALL TESTS PASSED. Everything is fine.' }, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = toolConversation(3, { failTurns: [2] })

    // The reducer auto-declared the failure from the failed tool result.
    const before = currentFoldState(ctx, session)
    const failure = before.openFailures['failure:call-2']
    expect(failure).toBeDefined()
    expect(failure!.failureState).toBe('open')
    expect(failure!.authority).toBe('empirical')

    // Fold with a semantic summary that lies: the state must stay FAIL.
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const after = currentFoldState(ctx, session)
    const stillOpen = after.openFailures['failure:call-2']
    if (stillOpen === undefined) {
      // The failure was folded into the checkpoint span; the state head must
      // still record it via the stateHeads face either way.
      const head = Object.values(after.stateHeads).find(a => a.id === 'failure:call-2')
      expect(head).toBeDefined()
      expect(head!.failureState).toBe('open')
    } else {
      expect(stillOpen.failureState).toBe('open')
    }
    // No narrative anchor exists anywhere in the state.
    for (const anchor of Object.values(after.stateHeads)) {
      expect(anchor.authority).not.toBe('narrative')
    }
  })

  it('S03: supersession — current shows the new value, recall keeps the old', async () => {
    const { ctx } = await createHarness({}, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = conversation(2)

    const timeout: StateKey = { namespace: 'config', entity: 'server', property: 'timeout' }
    const seq30 = appendUserText(session, 3, 'set timeout 30')
    declare(session, anchor({
      kind: 'value',
      stateKey: timeout,
      value: 30,
      authority: 'normative',
      sourceRefs: [{ seq: seq30 as never }],
    }))
    const seq60 = appendUserText(session, 4, 'set timeout 60')
    declare(session, anchor({
      kind: 'value',
      stateKey: timeout,
      value: 60,
      authority: 'normative',
      sourceRefs: [{ seq: seq60 as never }],
    }))

    const state = currentFoldState(ctx, session)
    const head = state.stateHeads[stateKeyText(timeout)]
    expect(head!.value).toBe(60)
    expect(head!.lifecycle).toBe('active')
    expect(stateStalenessRate(state)).toBe(0)

    // The old value remains recoverable from the session log (exact recall).
    const oldEvent = session.eventAt(seq30 as never)
    expect(JSON.stringify(oldEvent!.data)).toContain('30')
  })
})

describe('S04–S06: lifecycle and decisions', () => {
  it('S04: failure lifecycle — only VERIFIED leaves hot state', async () => {
    const { ctx } = await createHarness({}, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = toolConversation(1, { failTurns: [1] })

    const failure = currentFoldState(ctx, session).openFailures['failure:call-1']
    expect(failure!.failureState).toBe('open')

    // OPEN → INVESTIGATING → RESOLVED keeps it hot.
    transition(session, 'failure:call-1', 'investigating')
    expect(currentFoldState(ctx, session).openFailures['failure:call-1']!.failureState).toBe('investigating')
    transition(session, 'failure:call-1', 'resolved')
    expect(currentFoldState(ctx, session).openFailures['failure:call-1']!.failureState).toBe('resolved')

    // RESOLVED → VERIFIED (with empirical evidence) retires it.
    const resultSeq = session.seq - 1
    transition(session, 'failure:call-1', 'verified', [{ seq: resultSeq as never }])
    const state = currentFoldState(ctx, session)
    expect(state.openFailures['failure:call-1']).toBeUndefined()
    expect(state.retiredCount).toBe(1)
  })

  it('S05: unverified completion — narrative kinds can never verify', async () => {
    // Assistant messages ground hypothesis/decision only.
    expect(canVerify(['assistant/message'])).toBe(false)
    // A semantic digest is narrative: never authoritative.
    expect(canVerify([])).toBe(false)
    // Tool evidence verifies.
    expect(canVerify(['tool/result'])).toBe(true)
    // The empty state never claims verified completions.
    expect(Object.values(emptyCurrentState().stateHeads)).toHaveLength(0)
  })

  it('S06: decision supersession — the current surface shows only the new decision', async () => {
    const { ctx } = await createHarness({}, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = conversation(1)

    const design: StateKey = { namespace: 'design', entity: 'parser', property: 'strategy' }
    const seqA = appendUserText(session, 2, 'adopt regex parser')
    declare(session, anchor({
      kind: 'decision', stateKey: design, value: 'regex', authority: 'decision',
      sourceRefs: [{ seq: seqA as never }],
    }))
    const seqB = appendUserText(session, 3, 'adopt recursive-descent parser instead')
    declare(session, anchor({
      kind: 'decision', stateKey: design, value: 'recursive-descent', authority: 'decision',
      sourceRefs: [{ seq: seqB as never }],
    }))

    const state = currentFoldState(ctx, session)
    const head = state.stateHeads[stateKeyText(design)]
    expect(head!.value).toBe('recursive-descent')
    // The old decision is gone from the decisions face: no stale duplicate.
    const stale = Object.values(state.decisions).filter(a => a.lifecycle !== 'active')
    expect(stale).toHaveLength(0)
    expect(stateStalenessRate(state)).toBe(0)
  })
})

describe('S07–S08: projection boundedness', () => {
  it('S07: hot state stays bounded across 1000 epochs', async () => {
    const { ctx } = await createHarness({}, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = conversation(1)

    for (let epoch = 1; epoch <= 1000; epoch += 1) {
      const seq = session.seq
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `epoch ${epoch} update ${'detail '.repeat(20)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      declare(session, anchor({
        kind: 'value',
        stateKey: { namespace: 'build', entity: 'current', property: 'epoch' },
        value: epoch,
        authority: 'normative',
        sourceRefs: [{ seq: (seq) as never }],
      }))
    }

    const state = currentFoldState(ctx, session)
    expect(Object.keys(state.stateHeads)).toHaveLength(1)
    expect(state.stateHeads['build/current/epoch']!.value).toBe(1000)
    // The hot state did not accumulate per-epoch lineage.
    expect(state.retiredCount).toBe(999)
    const serialized = JSON.stringify(state)
    expect(serialized.length).toBeLessThan(4000)
  })

  it('S08: projection size does not scale with total history', async () => {
    const sizes: number[] = []
    for (const epochs of [100, 1000]) {
      const { ctx } = await createHarness({}, MOUNT)
      registerEpistemicFoldProjection(ctx)
      const session = conversation(1)
      for (let epoch = 1; epoch <= epochs; epoch += 1) {
        const seq = session.seq
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `epoch ${epoch} update ${'detail '.repeat(20)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        declare(session, anchor({
          kind: 'value',
          stateKey: { namespace: 'build', entity: 'current', property: 'epoch' },
          value: epoch,
          authority: 'normative',
          sourceRefs: [{ seq: (seq) as never }],
        }))
      }
      sizes.push(JSON.stringify(currentFoldState(ctx, session)).length)
    }
    // State size is flat as history grows 10x.
    expect(sizes[1]!).toBeLessThan(sizes[0]! * 2)
  })
})

describe('M3a rendering and gates', () => {
  it('structured checkpoint renders Current/Evidence/Open/Rationale/Recall', async () => {
    const { engine, ctx } = await createHarness({ text: 'why we folded' }, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = toolConversation(2, { failTurns: [2] })
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const summaryEvent = session.eventAt((session.seq - 2) as never)
    const state = currentFoldState(ctx, session)
    const rendered = renderStructuredCheckpoint(state, 'test-cp', 'why we folded')
    expect(rendered).toContain('[EF checkpoint v1 mode=leaf id=test-cp]')
    expect(rendered).toContain('Current')
    expect(rendered).toContain('Evidence')
    expect(rendered).toContain('Open')
    // The failure's DESCRIPTION must reach the surface, not just its id: an
    // id-only line tells the model something is unresolved but not what, which
    // was observed to produce a wrong answer on the live behavioral subset.
    expect(rendered).toContain('[failure] failure:call-2 (open)')
    expect(rendered).toMatch(/\[failure\] failure:call-2 \(open\): .+/u)
    expect(rendered).toContain('Rationale')
    expect(rendered).toContain('- why we folded')
    expect(rendered).toContain('Recall')
    expect(rendered).toContain('- cp:test-cp')
    void summaryEvent
  })

  it('gate: ALR=0 and SSR=0 hold across folds and epochs', async () => {
    const { engine, ctx } = await createHarness({ text: 'digest' }, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = conversation(4)
    const seq = appendUserText(session, 5, 'keep tests green')
    const keep = anchor({
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'tests' },
      value: 'keep tests green',
      authority: 'normative',
      sourceRefs: [{ seq: seq as never }],
    })
    declare(session, keep)

    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const state = currentFoldState(ctx, session)
    expect(authorityLossRate([keep.id], state)).toBe(0)
    expect(stateStalenessRate(state)).toBe(0)
  })

  it('gate: EvidenceOverridesNarrative holds for every transition kind', () => {
    expect(canVerify(['user/message'])).toBe(false)
    expect(canVerify(['assistant/message'])).toBe(false)
    expect(canVerify(['tool/result'])).toBe(true)
    // Mixed evidence with any narrative-adjacent source fails closed.
    expect(canVerify(['tool/result', 'assistant/message'])).toBe(false)
  })
})

describe('M3a: unverified completion refuses hot verification', () => {
  it('assistant claims do not create verified state', async () => {
    const { ctx } = await createHarness({}, MOUNT)
    registerEpistemicFoldProjection(ctx)
    const session = toolConversation(1, { failTurns: [1] })
    void ToolCallId

    // The assistant says "done" — no anchor op may reference narrative
    // authority; the reducer has no path that turns prose into verified.
    const state = currentFoldState(ctx, session)
    expect(state.openFailures['failure:call-1']!.failureState).toBe('open')
    // An attempted direct verified transition without evidence is a no-op at
    // the reducer level (validated upstream by canVerify).
    transition(session, 'failure:call-1', 'verified', [])
    expect(currentFoldState(ctx, session).openFailures['failure:call-1']!.failureState).toBe('open')
  })
})
