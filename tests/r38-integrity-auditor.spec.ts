/**
 * R38-M0 WP2: the read-only integrity auditor.
 *
 * The cases live in `eval/r38/integrity-audit.mjs` so the test and the JSON
 * artifact cannot drift. The structural test at the bottom enforces the
 * brief's hardest rule: conflict detection must not acquire write authority.
 *
 * @module tests/r38-integrity-auditor
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCases } from '../eval/r38/integrity-audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const results = runCases()
const byId = new Map(results.map(row => [row.id, row]))

describe('R38-WP2: integrity auditor', () => {
  it('passes every certified case', () => {
    expect(results.length).toBeGreaterThanOrEqual(9)
    expect(results.filter(row => !row.pass)).toEqual([])
  })

  it('keeps N5 as a permanent regression: the incomplete revision is found', () => {
    const row = byId.get('n5-incomplete')!
    const finding = row.findings.find(entry => entry.code === 'stale-negative-knowledge')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('requires-review')
    expect(finding!.anchorIds).toHaveLength(2)
    expect(finding!.detail).toContain('durable outbox')
  })

  it('clears the same case once the revision supersedes both coordinates', () => {
    const row = byId.get('n5-complete')!
    expect(row.actualCodes).not.toContain('stale-negative-knowledge')
    expect(row.counts.blocking).toBe(0)
  })

  it('separates cross-scope candidates from same-scope conflicts', () => {
    const cross = byId.get('cross-scope-opposites')!
    expect(cross.findings.find(entry => entry.code === 'cross-scope-conflict-candidate')?.severity)
      .toBe('informational')
    const same = byId.get('same-scope-opposites')!
    expect(same.findings.find(entry => entry.code === 'conflicting-active-anchors')?.severity)
      .toBe('requires-review')
  })

  it('does not flag two unrelated facts that share a keyword', () => {
    const row = byId.get('shared-keyword-only')!
    expect(row.actualCodes).toEqual([])
  })

  it('flags a historical unauthorized retirement as blocking', () => {
    const row = byId.get('historical-unauthorized-retirement')!
    const finding = row.findings.find(entry => entry.code === 'unauthorized-retirement')
    expect(finding?.severity).toBe('blocking')
  })

  it('reports a missing source ref and an unresolved dependency', () => {
    expect(byId.get('missing-source-evidence')!.findings[0]?.severity).toBe('blocking')
    expect(byId.get('unresolved-dependency')!.findings[0]?.severity).toBe('requires-review')
  })

  it('is read-only by construction', async () => {
    const source = await readFile(join(HERE, '..', 'eval', 'r38', 'src', 'integrity-auditor.ts'), 'utf8')
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/u)
    expect(source).not.toMatch(/createAnchorService|anchor-service/u)
    expect(source).not.toMatch(/\.retire\(/u)
    expect(source).not.toMatch(/semanticJournal|journal\.write/u)
  })
})
