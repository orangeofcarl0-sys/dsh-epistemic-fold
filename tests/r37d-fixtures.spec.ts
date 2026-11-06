/**
 * R37-D WP3: the fixed-context fixtures are frozen and reproducible.
 *
 * These assertions read the committed manifest and fixture bytes. They do not
 * call a provider and do not regenerate a checkpoint.
 *
 * @module tests/r37d-fixtures
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTree } from '../eval/r33/src/dataset.mjs'

const ROOT = process.cwd()
const manifest = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'fixed-context-manifest.json'), 'utf8'))
const cases = manifest.cases as Record<string, Record<string, any>>
const workspaces = manifest.workspace as Record<string, any>

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hashFiles(files: Record<string, string>): string {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  const hash = createHash('sha256')
  for (const [path, content] of entries) {
    hash.update(path, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(content, 'utf8')
    hash.update('\0', 'utf8')
  }
  return hash.digest('hex')
}

function caseRoot(caseId: string): string {
  const candidates = [
    join(ROOT, 'eval', 'r37', 'cases', caseId),
    join(ROOT, 'eval', 'r33', 'cases', caseId),
  ]
  const found = candidates.find(candidate => existsSync(join(candidate, 'case.json')))
  if (found === undefined) throw new Error(`case root not found for ${caseId}`)
  return found
}

function fixture(caseId: string, arm: string): any {
  const value = cases[caseId]?.[arm]
  if (value === undefined) throw new Error(`fixture not found for ${caseId}/${arm}`)
  return value
}

describe('R37-D fixed contexts', () => {
  it('freezes four fixtures, one per case and arm', () => {
    expect(manifest.verification.fixtures).toBe(4)
    expect(manifest.verification.distinctCheckpointDigests).toBe(4)
    expect(manifest.verification.allSelectedAreG0R1).toBe(true)
    expect(manifest.verification.allCandidatesRecorded).toBe(true)
    expect(manifest.verification.secretFindings).toBe(0)
    for (const caseId of ['B2', 'D1-v2']) {
      for (const arm of ['B1', 'S']) {
        expect(fixture(caseId, arm).selected).toBeDefined()
      }
    }
  })

  it('keeps the fixture bytes equal to the selected checkpoint digest', () => {
    for (const arms of Object.values(cases)) {
      for (const value of Object.values(arms)) {
        const selected = value.selected
        const contextPath = join(ROOT, selected.fixture.context)
        const metaPath = join(ROOT, selected.fixture.meta)
        const context = readFileSync(contextPath, 'utf8')
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        expect(context.length).toBe(selected.checkpointChars)
        expect(sha256(context)).toBe(selected.checkpointDigest)
        expect(meta.checkpointDigest).toBe(selected.checkpointDigest)
        expect(['B1', 'S']).toContain(meta.arm)
        expect(value.candidates.length).toBe(6)
        expect(value.candidates.filter((candidate: any) => candidate.selected).length).toBe(1)
        expect(selected.guard).toBe('G0')
        expect(selected.replicateId).toBe('r1')
      }
    }
  })

  it('does not use the same context for B1 and S', () => {
    for (const caseId of ['B2', 'D1-v2']) {
      const b1 = readFileSync(join(ROOT, fixture(caseId, 'B1').selected.fixture.context), 'utf8')
      const s = readFileSync(join(ROOT, fixture(caseId, 'S').selected.fixture.context), 'utf8')
      expect(b1).not.toBe(s)
      expect(fixture(caseId, 'B1').selected.checkpointDigest)
        .not.toBe(fixture(caseId, 'S').selected.checkpointDigest)
    }
  })

  it('records that every gold fact is visible in the selected context', () => {
    for (const arms of Object.values(cases)) {
      for (const value of Object.values(arms)) {
        expect(value.selected.facts.length).toBeGreaterThan(0)
        for (const fact of value.selected.facts) {
          expect(fact.factVisible).toBe(true)
        }
      }
    }
  })

  it('binds each case to its real initial workspace', async () => {
    for (const [caseId, workspace] of Object.entries(workspaces)) {
      const files = await readTree(join(caseRoot(caseId), 'workspace'))
      expect(Object.keys(files).length).toBe(workspace.files)
      expect(hashFiles(files)).toBe(workspace.digest)
    }
  })

  it('declares an outcome-blind selection rule', () => {
    expect(manifest.selectionRule.guard).toBe('G0 (no finish guard)')
    expect(manifest.selectionRule.candidateOrder).toEqual(['r1', 'r2', 'r3'])
    expect(manifest.selectionRule.outcomeBlind).toBe(true)
  })
})
