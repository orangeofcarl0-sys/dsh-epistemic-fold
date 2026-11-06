/**
 * R38-M0 WP3: task-aware selection, shadow only.
 *
 * The ablation rows come from `eval/r38/working-set-ablation.mjs`; the
 * structural tests pin the two properties the brief cares most about:
 *
 *  - the selector never reads a benchmark gold label;
 *  - selected and omitted are exact complements over the eligible set, and
 *    pinned state is never dropped.
 *
 * @module tests/r38-task-aware
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAblation } from '../eval/r38/working-set-ablation.mjs'
import { selectTaskAwareContext } from '../eval/r38/src/task-aware-selector.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { emptyCurrentState, stateKeyText } from '../src/state/state.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'
import type { TaskFrame } from '../eval/r38/src/task-aware-selector.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const rows = runAblation()
const byId = new Map(rows.map(row => [row.id, row]))

const anchor = (options: {
  id: string
  entity: string
  property: string
  value: string
  authority: Anchor['authority']
  seq: number
}): Anchor => ({
  id: options.id,
  kind: options.entity === 'finding' ? 'evidence' : options.entity === 'rejected-approach' ? 'decision' : options.entity as Anchor['kind'],
  stateKey: { namespace: 'semantic', entity: options.entity, property: options.property },
  value: options.value,
  authority: options.authority,
  lifecycle: 'active',
  sourceRefs: [{ seq: SessionSeq(options.seq) }],
})

function stateWith(anchors: readonly Anchor[]): FoldCurrentState {
  const state = emptyCurrentState()
  for (const entry of anchors) {
    state.stateHeads[stateKeyText(entry.stateKey!)] = entry
    if (entry.kind === 'decision') state.decisions[entry.id] = entry
    if (entry.kind === 'evidence') state.evidence[entry.id] = entry
  }
  return state
}

const frame = (request: string, files: readonly string[] = []): TaskFrame => ({
  sessionId: 's',
  files,
  symbols: [],
  currentRequest: request,
  semanticStateRevision: 'r1',
  sessionEventWatermark: 10,
})

describe('R38-WP3: task-aware selection', () => {
  it('passes every ablation check', () => {
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(byId.get('greedy-skip')!.invariants.disjoint).toBe(true)
    expect(byId.get('greedy-skip')!.invariants.complete).toBe(true)
  })

  it('rescues the smaller candidate the prefix selector drops', () => {
    const row = byId.get('greedy-skip')!
    expect(row.s0.selected).not.toContain('semantic-greedy-c')
    expect(row.s1.selected).toContain('semantic-greedy-c')
    // The content the selector kept still fits the budget.
    expect(row.s1.contentTokens).toBeLessThanOrEqual(row.budget)
  })

  it('keeps a relevant older rejection under budget pressure', () => {
    const row = byId.get('n5-budget-pressure')!
    expect(row.s0.criticalVisible).toBe(0)
    expect(row.s1.criticalVisible).toBe(1)
    expect(row.s1.negativeKnowledgeVisible).toBe(1)
    expect(row.s1.unrelatedTokens).toBeLessThan(row.s0.unrelatedTokens)
  })

  it('prefers the in-scope decision and records the other scope explicitly', () => {
    const row = byId.get('scope-separation')!
    expect(row.s1.selected).toContain('semantic-decision-repo-a')
    expect(row.s1.selected).not.toContain('semantic-decision-repo-b')
    expect(row.s1.unresolvedCoverage).toContain('scope-mismatch:semantic-decision-repo-b')
    expect(row.s1.scopePrecision).toBeGreaterThan(row.s0.scopePrecision)
  })

  it('reports pinned overflow instead of dropping a contract', () => {
    const row = byId.get('pinned-overflow')!
    expect(row.s1.pinnedOverflow).toBe(true)
    expect(row.s1.selected).toContain('semantic-constraint-long')
    expect(row.invariants.pinnedAllSelected).toBe(true)
  })

  it('is stable under input order', () => {
    expect(rows.every(row => row.s1.stable)).toBe(true)
  })

  it('changes the selection when the task changes', () => {
    const state = stateWith([
      anchor({ id: 'queue', entity: 'decision', property: 'scheduler-queue', value: 'Use the in-memory scheduler queue.', authority: 'decision', seq: 1 }),
      anchor({ id: 'region', entity: 'decision', property: 'deploy-region', value: 'Deploy to eu-west-2.', authority: 'decision', seq: 2 }),
    ])
    const scheduler = selectTaskAwareContext({
      state,
      frame: frame('Modify the scheduler queue implementation.'),
      budgetTokens: 40,
    })
    const deployment = selectTaskAwareContext({
      state,
      frame: frame('Change the production deployment region.'),
      budgetTokens: 40,
    })
    expect(scheduler.selectedAnchorIds).not.toEqual(deployment.selectedAnchorIds)
    expect(scheduler.selectionDigest).not.toBe(deployment.selectionDigest)
    expect(scheduler.selectedAnchorIds).toContain('queue')
    expect(deployment.selectedAnchorIds).toContain('region')
  })

  it('keeps every selected fact traceable to source seqs', () => {
    const state = stateWith([
      anchor({ id: 'a', entity: 'decision', property: 'a', value: 'Use the scheduler queue.', authority: 'decision', seq: 7 }),
      anchor({ id: 'b', entity: 'finding', property: 'b', value: 'The scheduler queue drains.', authority: 'empirical', seq: 9 }),
    ])
    const selection = selectTaskAwareContext({ state, frame: frame('scheduler queue'), budgetTokens: 200 })
    expect(selection.sourceRefs).toContain(7)
    expect(selection.sourceRefs).toContain(9)
  })

  it('never reads a benchmark gold label', async () => {
    const source = await readFile(join(HERE, '..', 'eval', 'r38', 'src', 'task-aware-selector.ts'), 'utf8')
    expect(source).not.toMatch(/criticalIds|negativeKnowledgeIds|unrelatedIds|gold|benchmark/iu)
  })
})
