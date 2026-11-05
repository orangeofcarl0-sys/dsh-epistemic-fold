/**
 * R37-A5: B2/C1 forensics and controlled representation fixtures.
 *
 * @module tests/r37-forensics
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../eval/r37/src/io.mjs'

const ROOT = process.cwd()
const forensics: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'forensics.json'),
  'utf8',
))
const index: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'representation-fixtures.json'),
  'utf8',
))

function run(caseId: string, runId: string): any {
  return forensics.cases[caseId].runs.find((entry: any) => entry.runId === runId)
}

function fixture(fixtureId: string): any {
  return JSON.parse(readFileSync(
    join(ROOT, 'eval', 'r37', 'fixtures', fixtureId, 'fixture.json'),
    'utf8',
  ))
}

describe('R37-A5: B2 forensic attribution', () => {
  it('attributes r1 to DSML content corruption, not to the decision', () => {
    const b2 = run('B2', 'r36-causal-B2')
    expect(b2.actualDelivery).toBe('semantic-committed')
    expect(b2.workspaceChanged).toBe(true)
    expect(b2.filesModified.map((entry: any) => entry.path)).toEqual(['src/scheduler.mjs'])
    expect(b2.earliestObservableDivergence.kind).toBe('tool-parameter-corruption')
    expect(b2.sufficientCause.kind).toBe('tool-parameter-corruption')
    expect(b2.decisionConsistency).toBe('action-consistent')
    expect(b2.classification).toBe('harness-protocol')
  })

  it('attributes r2 to an implementation/process stop, not to forgetting', () => {
    const b2 = run('B2', 'r36-causal-r2-B2')
    expect(b2.workspaceChanged).toBe(false)
    expect(b2.filesModified).toEqual([])
    expect(b2.testsObserved.testsExecuted).toBe(0)
    expect(b2.decisionConsistency).toBe('no-observed-action')
    expect(b2.classification).toBe('implementation-correctness')
  })
})

describe('R37-A5: C1 forensic attribution', () => {
  it('keeps the refused fold as a fallback, not as a semantic checkpoint', () => {
    const c1 = run('C1', 'r36-causal-C1')
    expect(c1.actualDelivery).toBe('full-history-fallback')
    expect(c1.foldFallback).toBe('full-history')
    expect(c1.fold.valid).toBe(false)
    expect(c1.workspaceChanged).toBe(false)
    expect(c1.classification).toBe('fold-refusal-then-implementation')
    expect(c1.factsAvailable.rendered.some((fact: any) => fact.rendered)).toBe(true)
  })

  it('records the committed polling run as a candidate, not a product claim', () => {
    const c1 = run('C1', 'r36-causal-r2-C1')
    expect(c1.actualDelivery).toBe('semantic-committed')
    expect(c1.workspaceChanged).toBe(true)
    expect(c1.filesModified.map((entry: any) => entry.path)).toEqual(['src/watcher.mjs'])
    expect(c1.decisionConsistency).toBe('action-consistent')
    expect(c1.classification).toBe('contract-success')
    expect(forensics.cases.C1.conclusion.join(' ')).toMatch(/n=1/u)
  })
})

describe('R37-A5: controlled representation fixtures', () => {
  it('labels every fixture as a controlled oracle-facts intervention', () => {
    expect(index.status).toBe('ready')
    expect(index.fixtures).toHaveLength(6)
    for (const entry of index.fixtures) {
      const data = fixture(entry.fixtureId)
      expect(data.label).toBe('controlled/oracle-facts intervention')
      expect(data.note).toMatch(/not an EF writer output/u)
      expect(data.contextDigest).toBe(sha256(data.contextText))
      expect(data.tokenEstimate).toBe(Math.ceil(data.contextText.length / 4))
    }
  })

  it('keeps F-P and F-S semantically equivalent for B2 and C1', () => {
    for (const [caseId, left, right] of [
      ['B2', 'B2-F-P', 'B2-F-S'],
      ['C1', 'C1-F-P', 'C1-F-S'],
    ] as const) {
      const plain = fixture(left)
      const structured = fixture(right)
      expect(plain.semanticEquivalence.equivalent).toBe(true)
      expect(structured.semanticEquivalence.equivalent).toBe(true)
      expect(plain.provenance.sourceRefs.length).toBeGreaterThan(0)
      expect(structured.provenance.authority.length).toBeGreaterThan(0)
      expect(caseId).toBe(plain.caseId)
    }
  })

  it('withholds the critical facts in the B2 negative control', () => {
    const withheld = fixture('B2-F-N')
    expect(withheld.semanticEquivalence.equivalent).toBe(false)
    expect(withheld.withheldFactIds).toEqual(['B2-memory', 'B2-outbox-rejected'])
    expect(withheld.contextText).not.toMatch(/in-memory queue/u)
  })

  it('uses only facts present in the frozen transcript', () => {
    const b2 = fixture('B2-F-P')
    expect(b2.criticalFacts.map((fact: any) => fact.sourceRefs)).toEqual([[0, 2], [2]])
    const c1 = fixture('C1-F-S')
    expect(c1.criticalFacts.map((fact: any) => fact.sourceRefs)).toEqual([[2], [0]])
    expect(forensics.warnings.join(' ')).toMatch(/No claim that the model understood or forgot/u)
  })
})
