/**
 * Where a tier's committed corpus lives -- the suite's read-only view of it.
 *
 * The layout is OWNED by eval/memory/corpus_paths.py, and this deliberately does not re-declare
 * the tier-to-label mapping. A test that wants a tier asks for it BY WINDOW and the directory is
 * found by reading `sizing.window`, so the two languages cannot disagree about a label, and
 * adding a tier does not require editing a table here.
 *
 * ## Why the corpus is per-tier at all
 *
 * documents.json is derived from EF_MEMORY_WINDOW, so a single copy could only serve one tier at
 * a time. Running 475K meant regenerating over 131K and dirtying tracked files, which put the slow
 * and failure-prone generator on the path to merely RUNNING the bench. Measured, only
 * documents.json and generation_report.json differ between tiers; probes, answer_key,
 * public_probes, orderings, corpus_core and errata are byte-identical and live once.
 *
 * @module tests/memory-corpus
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MEM = join(import.meta.dirname, '..', 'eval', 'memory')
export const CORPORA = join(MEM, 'corpora')

/** The tiers this benchmark targets. */
export const TIERS = [131_072, 258_048, 475_136, 1_048_576] as const

export interface TierReport {
  readonly label: string
  readonly dir: string
  readonly window: number
  readonly report: Record<string, any>
}

/** Every committed tier, read from its own generation report. */
export function committedTiers(): readonly TierReport[] {
  if (!existsSync(CORPORA)) return []
  const out: TierReport[] = []
  for (const label of readdirSync(CORPORA).sort()) {
    const dir = join(CORPORA, label)
    const reportPath = join(dir, 'generation_report.json')
    if (!existsSync(reportPath) || !existsSync(join(dir, 'documents.json'))) continue
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, any>
    out.push({ label, dir, window: Number(report.sizing?.window), report })
  }
  return out
}

/** The committed tier for one window, or undefined. */
export function tierFor(window: number): TierReport | undefined {
  return committedTiers().find(t => t.window === window)
}

/** A shared artifact: one of the six that are byte-identical across tiers. */
export function sharedFile(name: string): string {
  return join(MEM, name)
}
