/**
 * Long-horizon behavior of the temporal body: 10, 30, and 100 folds.
 *
 * These are PURE simulations of the per-fold compile step. They answer the
 * question a single-checkpoint test cannot: does the representation the model
 * reads stay bounded as the fold chain grows, and is the LATEST value the one
 * it reads at fold 100?
 *
 * What is measured:
 *
 *   body tokens        the compiled temporal body, chars/4 (labelled)
 *   frozen-chain bytes every body concatenated; the surface cost if nothing is
 *                      retired or root-rebased (Exit/Root own that, not this)
 *   latest correctness the current value is visible and the prior one is not
 *   pinned presence    a never-rementioned user constraint on every fold
 *   retrieval pointer  omitted working state is counted, never silently gone
 *
 * @module tests/semantic-longchain
 */

import { describe, expect, it } from 'vitest'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { changedAnchors, changedOverflowLine } from '../src/semantic/changes.ts'
import { compileWorkingSet } from '../src/semantic/working-set-compiler.ts'
import { renderTemporalCheckpoint } from '../src/checkpoint/renderer.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import { canonicalHash } from '../src/checkpoint/hash.ts'
import type { FoldCurrentState } from '../src/state/state.ts'
import type { AcceptedDelta } from '../src/semantic/types.ts'

const estimate = (text: string): number => Math.ceil(text.length / 4)

let deltaCounter = 0

/** One accepted delta with a unique identity and one span-seq citation. */
function accepted(overrides: Partial<AcceptedDelta> & { readonly seq: number }): AcceptedDelta {
  deltaCounter += 1
  // Anchor ids take the FIRST 32 hex characters of the delta id, so the
  // fixture's entropy must be there too; a zero-padded counter collapsed every
  // id onto one anchor.
  const id = canonicalHash({ n: deltaCounter, seq: overrides.seq, statement: overrides.statement ?? '' })
  return {
    index: deltaCounter,
    deltaId: id,
    kind: 'decision',
    subjectKey: `subject-${deltaCounter}`,
    statement: `Decision ${deltaCounter}.`,
    status: 'claimed',
    grantedStatus: 'claimed',
    evidence: [{ seq: overrides.seq, messageDigest: `m-${deltaCounter}`, quote: `quote-${deltaCounter}` }],
    authority: 'decision',
    anchorKind: 'decision',
    stateKey: { namespace: 'semantic', entity: 'decision', property: `subject-${deltaCounter}` },
    supersedes: [],
    dependsOn: [],
    rulesOut: [],
    ...overrides,
  }
}

/** The pinned constraint: declared once, never touched by any later fold. */
const PINNED = accepted({
  seq: 0,
  kind: 'constraint',
  subjectKey: 'public-api',
  statement: 'The public API must not change.',
  authority: 'normative',
  anchorKind: 'constraint',
  stateKey: { namespace: 'semantic', entity: 'constraint', property: 'public-api' },
})

/** One simulated fold's observable result. */
interface FoldTrace {
  readonly body: string
  readonly bodyTokens: number
  readonly workingSetTokens: number
  readonly omitted: number
}

/**
 * Run `folds` revisions. Each fold revises `timeout`, adds one decision, and
 * every fifth fold records a rejected approach.
 */
function simulate(folds: number): { readonly traces: readonly FoldTrace[]; readonly state: FoldCurrentState } {
  let state = applyOps(emptyCurrentState(), planCommit([PINNED], { state: emptyCurrentState() }).ops)
  const traces: FoldTrace[] = []

  for (let fold = 1; fold <= folds; fold += 1) {
    const seqBase = fold * 10
    const deltas: AcceptedDelta[] = [
      accepted({
        seq: seqBase,
        kind: 'constraint',
        subjectKey: 'timeout',
        statement: `The timeout is ${fold}ms.`,
        authority: 'normative',
        anchorKind: 'constraint',
        stateKey: { namespace: 'semantic', entity: 'constraint', property: 'timeout' },
        supersedes: ['previous'],
      }),
      accepted({
        seq: seqBase + 1,
        statement: `Decision ${fold} on the current approach.`,
      }),
    ]
    if (fold % 5 === 0) {
      deltas.push(accepted({
        seq: seqBase + 2,
        kind: 'rejected-approach',
        subjectKey: `rejected-${fold}`,
        statement: `Approach ${fold} was rejected.`,
        authority: 'decision',
        anchorKind: 'decision',
        stateKey: { namespace: 'semantic', entity: 'rejected-approach', property: `rejected-${fold}` },
        rulesOut: [`approach-${fold}`],
      }))
    }
    // `knownAnchorIds` is the projected state's ids, exactly as the engine passes it.
    state = applyOps(state, planCommit(deltas, { state }).ops)

    const changed = changedAnchors(state, [seqBase, seqBase + 1, seqBase + 2])
    const compiled = compileWorkingSet({
      state,
      exclude: new Set(changed.all.map(anchor => anchor.id)),
      budgetTokens: 1024,
      estimate,
    })
    const overflow = changedOverflowLine(changed.omitted.length)
    const body = renderTemporalCheckpoint({
      checkpointId: `cp-${fold}`,
      mode: 'leaf',
      changed: changed.shown,
      workingSetText: [compiled.text, overflow ?? ''].filter(part => part.length > 0).join('\n\n'),
      rationale: `Fold ${fold} rationale.`,
    })
    traces.push({
      body,
      bodyTokens: estimate(body),
      workingSetTokens: compiled.tokens,
      omitted: compiled.omitted.length,
    })
  }
  return { traces, state }
}

describe('long-horizon working set', () => {
  for (const folds of [10, 30, 100]) {
    it(`stays bounded and keeps the latest value over ${folds} folds`, () => {
      const { traces } = simulate(folds)
      const last = traces[traces.length - 1]!
      // The latest revision is what the model reads...
      expect(last.body).toContain(`The timeout is ${folds}ms.`)
      // ...and the immediately prior one is not presented as current.
      if (folds > 1) expect(last.body).not.toContain(`The timeout is ${folds - 1}ms.`)
      // The never-rementioned constraint is carried on every fold.
      expect(last.body).toContain('The public API must not change.')
      // The body is bounded by the WORKING-SET BUDGET plus the fold's own
      // changes and framing — not by the number of folds. It fills toward the
      // budget as facts accumulate, then stops.
      // The budget bounds pinned+working lines; the "Not shown" pointer and
      // the overflow notice are added after it, so a small overrun is expected.
      expect(last.workingSetTokens).toBeLessThanOrEqual(1_200)
      expect(last.bodyTokens).toBeLessThan(1_800)
      // Omitted working state becomes a countable pointer, never a deletion.
      if (last.omitted > 0) expect(last.body).toContain('Not shown')
      // Reproducible measurement for docs/semantic-continuity/EVALUATION.md.
      // eslint-disable-next-line no-console
      console.log(
        `longchain ${String(folds).padStart(3)} folds: lastBody=${last.bodyTokens}t `
        + `workingSet=${last.workingSetTokens}t omitted=${last.omitted}`,
      )
    })
  }

  it('reports the frozen-chain cost that Exit / root rebase must remove', () => {
    // The temporal body bounds EACH checkpoint. The frozen chain is still the
    // sum of them until a retirement or root rebase removes the older bodies;
    // this test states that cost rather than pretending the body bounds it.
    const ten = simulate(10).traces
    const hundred = simulate(100).traces
    const tenSum = ten.reduce((sum, trace) => sum + trace.bodyTokens, 0)
    const hundredSum = hundred.reduce((sum, trace) => sum + trace.bodyTokens, 0)
    expect(hundredSum).toBeGreaterThan(tenSum)
    // LINEAR, not quadratic, and with a bounded slope: every body is under the
    // same ceiling, so N folds cost O(N) bodies of at most 1,800 tokens each.
    // (The frozen chain still needs Exit or a root rebase to shrink; this is
    // the number those mechanisms act on, not a claim that they are unnecessary.)
    expect(hundredSum / 100).toBeLessThan(1_800)
    expect(Math.max(...hundred.map(trace => trace.bodyTokens))).toBeLessThan(1_800)
    // eslint-disable-next-line no-console
    console.log(
      `frozen chain: 10 folds total=${tenSum}t avg=${(tenSum / 10).toFixed(1)}t; `
      + `100 folds total=${hundredSum}t avg=${(hundredSum / 100).toFixed(1)}t `
      + `max=${Math.max(...hundred.map(trace => trace.bodyTokens))}t`,
    )
  })
})

describe('root truncation and pinned overflow', () => {
  it('shows the pinned contract first and states how many changes were omitted', () => {
    // A root fold can shadow hundreds of messages. Reuse the pinned constraint
    // and add 100 changed anchors in ONE span.
    // A root-span constraint, so the pinned item is IN the changed set.
    const pinnedInSpan = accepted({
      seq: 1,
      kind: 'constraint',
      subjectKey: 'public-api',
      statement: 'The public API must not change.',
      authority: 'normative',
      anchorKind: 'constraint',
      stateKey: { namespace: 'semantic', entity: 'constraint', property: 'public-api' },
    })
    const many = Array.from({ length: 100 }, (_, index) => accepted({ seq: 1, statement: `Root item ${index}.` }))
    const state = applyOps(emptyCurrentState(), planCommit([pinnedInSpan, ...many], { state: emptyCurrentState() }).ops)

    const changed = changedAnchors(state, [1], 24)
    // The quota applies to WORKING anchors: the pinned contract is rendered on
    // top of the 24 changed items the cap allows, so nothing binding is dropped.
    expect(changed.shown).toHaveLength(25)
    expect(changed.pinned).toHaveLength(1)
    expect(changed.omitted).toHaveLength(76) // 100 working changed, 24 shown
    // Pinned first: the user's contract can never be the item the cap drops.
    expect(changed.shown[0]!.id).toBe(`semantic-${pinnedInSpan.deltaId.slice(0, 32)}`)
    expect(changedOverflowLine(changed.omitted.length)).toContain('more changed item(s) not shown')
  })

  it('never silently drops pinned state, even when pinned alone exceeds the budget', () => {
    let state = emptyCurrentState()
    const constraints = Array.from({ length: 20 }, (_, index) => accepted({
      seq: 1,
      kind: 'constraint',
      subjectKey: `constraint-${index}`,
      statement: `Binding constraint ${index}.`,
      authority: 'normative',
      anchorKind: 'constraint',
      stateKey: { namespace: 'semantic', entity: 'constraint', property: `constraint-${index}` },
    }))
    state = applyOps(state, planCommit(constraints, { state }).ops)
    const compiled = compileWorkingSet({ state, budgetTokens: 128, estimate })
    expect(compiled.pinned).toHaveLength(20)
    expect(compiled.overflow).toBe(true)
    expect(compiled.text).toContain('working-set-overflow')
    expect(compiled.text).toContain('Binding constraint 19.')
  })
})
