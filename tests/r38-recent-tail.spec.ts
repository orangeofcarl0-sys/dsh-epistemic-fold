/**
 * R38-M0 WP5: recent-tail consistency.
 *
 * @module tests/r38-recent-tail
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCases, runDeterminism } from '../eval/r38/recent-tail.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const rows = runCases()
const byId = new Map(rows.map(row => [row.id, row]))

describe('R38-WP5: recent-tail consistency', () => {
  it('leaves every anchor safe when there is no tail', () => {
    const row = byId.get('no-tail-update')!
    expect(row.warnings).toEqual([])
    expect(row.unsafeAnchorIds).toEqual([])
    expect(row.anchors.every(anchor => anchor.verdict === 'no-later-event')).toBe(true)
  })

  it('detects an explicit user revision of a decision', () => {
    const row = byId.get('explicit-user-revision')!
    expect(row.verdictOf.queue).toBe('superseded-by-user')
    expect(row.unsafeAnchorIds).toContain('queue')
    expect(row.warnings.some(line => line.includes('reconcile queue'))).toBe(true)
  })

  it('does not call a task-relevant user message a proven revision', () => {
    const row = byId.get('weak-task-signal')!
    expect(row.verdictOf.queue).toBe('requires-reconciliation')
    expect(row.verdictOf.queue).not.toBe('superseded-by-user')
  })

  it('never lets a tool observation revoke a constraint', () => {
    const row = byId.get('tool-observation')!
    expect(row.verdictOf.release).toBe('no-effect')
    expect(row.verdictOf.depth).toBe('requires-reconciliation')
    expect(row.unsafeAnchorIds).not.toContain('release')
  })

  it('never lets an assistant message override a user constraint', () => {
    const row = byId.get('assistant-hypothesis')!
    expect(row.verdictOf.release).toBe('no-effect')
    expect(row.unsafeAnchorIds).not.toContain('release')
  })

  it('treats a different scope as a different scope', () => {
    const row = byId.get('different-scope')!
    expect(row.verdictOf['repo-a-gate']).toBe('scope-different')
    expect(row.unsafeAnchorIds).toEqual([])
  })

  it('reports a frame that is older than the session tail', () => {
    const row = byId.get('concurrent-advancement')!
    expect(row.frameStale).toBe(true)
    expect(row.warnings.some(line => line.startsWith('frame-stale'))).toBe(true)
  })

  it('produces no warning for an unrelated event', () => {
    expect(byId.get('no-evidence')!.warnings).toEqual([])
  })

  it('is deterministic across a rebuild and an input permutation', () => {
    const determinism = runDeterminism()
    expect(determinism.stable).toBe(true)
    expect(determinism.first).toBe(determinism.reordered)
  })

  it('does not write state', async () => {
    const source = await readFile(join(HERE, '..', 'eval', 'r38', 'src', 'recent-tail.ts'), 'utf8')
    expect(source).not.toMatch(/applyOps|planCommit|semanticJournal|journal\.write|createAnchorService/u)
  })
})
