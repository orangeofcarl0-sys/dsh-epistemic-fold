/**
 * R38-M0 WP4: bounded archive recovery.
 *
 * The rows come from `eval/r38/archive-recovery-ablation.mjs`, which writes
 * real bundles through `FileBundleStore` and reads them through `recall`.
 *
 * @module tests/r38-archive-recovery
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAblation } from '../eval/r38/archive-recovery-ablation.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const rows = await runAblation()
const byId = new Map(rows.map(row => [row.id, row]))

describe('R38-WP4: bounded archive recovery', () => {
  it('rescues an archive-only fact that neither selector could see', () => {
    for (const id of ['h1-production-region', 's1-production-timeout']) {
      const row = byId.get(id)!
      expect(row.coverage.s0).toBe(false)
      expect(row.coverage.s1).toBe(false)
      expect(row.coverage.s2).toBe(true)
      expect(row.metrics.archiveOnlyRescue).toBe(true)
      expect(row.recovery.status).toBe('found-in-archive-only')
    }
  })

  it('does not claim absence when the scope was fully searched', () => {
    const row = byId.get('archive-miss')!
    expect(row.recovery.status).toBe('not-found-in-checked-scope')
    expect(row.coverage.s2).toBe(false)
  })

  it('does not claim absence when a bound stopped the search', () => {
    const row = byId.get('descriptor-budget')!
    expect(row.recovery.status).toBe('coverage-not-assessed')
    expect(row.recovery.notes.some(note => note.startsWith('descriptor-limit'))).toBe(true)
  })

  it('returns the in-scope passage and nothing from another scope', () => {
    const row = byId.get('scope-mismatch')!
    expect(row.coverage.s2).toBe(true)
    expect(row.metrics.falseRetrieval).toBe(0)
    expect(row.metrics.scopeCorrectness).toBe(1)
  })

  it('never modifies semantic state', () => {
    expect(rows.every(row => row.authority.stateDigestUnchanged)).toBe(true)
    expect(rows.every(row => row.authority.stateUnchangedFlag)).toBe(true)
  })

  it('respects every frozen bound', () => {
    expect(rows.every(row => Object.values(row.bounds).every(Boolean))).toBe(true)
  })

  it('does not put the answer into the query', () => {
    for (const row of rows) {
      for (const term of row.terms) {
        if (term.length < 3) continue
        expect(row.criticalTerm.toLowerCase()).not.toContain(term.toLowerCase())
      }
    }
  })

  it('reuses recall instead of a second archive backend', async () => {
    const source = await readFile(join(HERE, '..', 'eval', 'r38', 'src', 'archive-recovery.ts'), 'utf8')
    expect(source).toContain("from '../../../src/recall/recall.ts'")
    expect(source).not.toMatch(/^import .*(embedding|vector|faiss|chroma|pinecone)/imu)
    expect(source).not.toMatch(/new (Map|Set)\(\)[\s\S]{0,80}archive index/iu)
  })
})
