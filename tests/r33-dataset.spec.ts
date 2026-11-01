/**
 * R33-A: the frozen dataset's own integrity.
 *
 * A benchmark whose counterfactuals differ in more than the decisive fact, or
 * whose initial workspace is not shared, cannot attribute a difference to
 * memory. These tests pin the properties the report relies on:
 *
 *  - the manifest digest still matches every case;
 *  - each counterfactual pair shares its workspace and task text;
 *  - the pair's DECISIVE fact differs (not merely its wording);
 *  - history-independent controls carry their specification in the workspace;
 *  - every gold quote is verbatim in its transcript (the schema also checks it,
 *    but this makes the requirement visible in the suite).
 *
 * @module tests/r33-dataset
 */

import { describe, expect, it } from 'vitest'
import { loadDataset, verifyFrozen } from '../eval/r33/src/dataset.mjs'

const PAIRS = [['A1', 'A2'], ['B1', 'B2'], ['C1', 'C2'], ['E1', 'E2'], ['F1', 'F2']] as const

describe('R33 frozen dataset', () => {
  it('verifies against the committed v2 manifest', async () => {
    const frozen = await verifyFrozen()
    expect(frozen.ok, frozen.reason).toBe(true)
    expect(frozen.manifest.datasetId).toBe('r33-semantic-continuity-v2')
    expect(frozen.manifest.scorerVersion).toBe(2)
    expect(frozen.manifest.supersedes.datasetId).toBe('r33-semantic-continuity-v1')
    const { cases, errors, datasetDigest } = await loadDataset()
    expect(errors).toEqual([])
    expect(cases).toHaveLength(17)
    expect(datasetDigest).toBe(frozen.datasetDigest)
  })

  it('makes every counterfactual pair share its initial state and task', async () => {
    const { cases } = await loadDataset()
    const byId = new Map(cases.map(entry => [entry.id, entry]))
    for (const [leftId, rightId] of PAIRS) {
      const left = byId.get(leftId)
      const right = byId.get(rightId)
      expect(left, `${leftId} missing`).toBeDefined()
      expect(right, `${rightId} missing`).toBeDefined()
      expect(left.workspace.files, `${leftId}/${rightId} workspace differs`).toEqual(right.workspace.files)
      expect(left.task, `${leftId}/${rightId} task differs`).toBe(right.task)
      // The DECISIVE fact must differ; otherwise the pair cannot change the
      // correct action and is a weak counterfactual.
      expect(left.gold[0].statement).not.toBe(right.gold[0].statement)
    }
  })

  it('keeps history-independent controls solvable from the workspace alone', async () => {
    const { cases } = await loadDataset()
    const controls = cases.filter(entry => entry.historyIndependent)
    expect(controls.map(entry => entry.id)).toEqual(['G1', 'G2'])
    for (const control of controls) {
      expect(Object.keys(control.workspace.files).some(path => path === 'README.md')).toBe(true)
    }
  })

  it('binds every gold quote to EVERY authoritative source reference', async () => {
    const { cases } = await loadDataset()
    for (const entry of cases) {
      const text = entry.transcript.map((message: { text: string }) => message.text).join('\n')
      for (const fact of entry.gold) {
        expect(text.includes(fact.quote), `${entry.id} ${fact.factId} quote`).toBe(true)
        for (const ref of fact.sourceRefs) {
          expect(
            entry.transcript[ref].text.includes(fact.quote),
            `${entry.id} ${fact.factId} sourceRefs[${ref}] does not contain the quote`,
          ).toBe(true)
        }
        // A corroborating citation MAY not contain the quote; that is the
        // distinction v2 introduces.
        for (const ref of fact.corroboratingRefs ?? []) {
          expect(entry.transcript[ref], `${entry.id} ${fact.factId} corroboratingRefs[${ref}]`).toBeDefined()
        }
      }
    }
  })

  it('declares the exact hidden checks each checker emits', async () => {
    const { cases } = await loadDataset()
    for (const entry of cases) {
      expect(entry.checker.expectedChecks.length, entry.id).toBeGreaterThan(0)
      expect(new Set(entry.checker.expectedChecks).size, entry.id).toBe(entry.checker.expectedChecks.length)
      for (const name of entry.checker.expectedChecks) {
        expect(entry.checker.source.includes(name), `${entry.id} never emits ${name}`).toBe(true)
      }
    }
  })

  it('does not leak a history-dependent gold fact into the workspace', async () => {
    const { cases } = await loadDataset()
    for (const entry of cases.filter(candidate => !candidate.historyIndependent)) {
      const files = Object.values(entry.workspace.files).join('\n')
      for (const fact of entry.gold) {
        expect(files.includes(fact.quote), `${entry.id} leaks ${fact.factId} quote`).toBe(false)
        expect(files.includes(fact.visibleNeedle), `${entry.id} leaks ${fact.factId} needle`).toBe(false)
      }
    }
  })
})
