/**
 * A fold's COUNT cannot answer how many times a given fact was folded.
 *
 * ## Why this exists
 *
 * `docs/62_MEMORY_PRESSURE_TASK_DESIGN.md` section 7 needs `exposure(f)` -- how many folds had
 * fact f inside the shadowed region -- and the lifetime counters cannot supply it. `folds` says
 * how many folds happened, not which seqs each one shadowed, so a fact ingested early and one
 * ingested late are indistinguishable in the telemetry while having very different histories.
 *
 * `CompactionResult` carries `shadowedSeqs` and `summarySeq`, and this host discarded the result
 * entirely: it read the engine's counters around the call and never looked at what came back.
 *
 * ## Why it is safe to add to a running lane
 *
 * Recording the result changes no behaviour -- no fold is triggered, suppressed or reordered --
 * so a measurement already in flight is unaffected by the change. That is why this was the first
 * item on the implementation checklist rather than something to defer until the lane went idle.
 *
 * ## Why the mechanism is a DELTA
 *
 * `CompactionResult` has no `kind` field, which this file already learned when it tried
 * substring-matching the result's JSON for one and could never fire. The mechanism is therefore
 * read from the counter deltas around the call, and the test pins that rather than a field that
 * does not exist.
 *
 * @module tests/fold-lineage
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const HOST = readFileSync(join(ROOT, 'eval', 'tau2', 'bridge-host.ts'), 'utf8')

describe('fold lineage', () => {
  it('declares the event shape and the telemetry field', () => {
    expect(HOST).toContain('interface FoldEvent')
    expect(HOST).toContain('readonly foldLineage: readonly FoldEvent[]')
    // The three mechanisms the engine commits, named rather than free text.
    expect(HOST).toMatch(/readonly mechanism: 'leaf' \| 'root' \| 'emergency'/u)
  })

  it('records the seqs a fold shadowed, which is what exposure is computed from', () => {
    expect(HOST).toContain('shadowedSeqs: [...(result.shadowedSeqs ?? [])]')
    expect(HOST).toContain('summarySeq: result.summarySeq ?? null')
    // Surface tokens either side, so the fold's own compression is visible.
    expect(HOST).toContain('tokensBefore,')
    expect(HOST).toMatch(/tokensAfter: ctx!\.tokenMeter\.measure/u)
  })

  it('derives the mechanism from counter DELTAS, because the result has no kind', () => {
    expect(HOST).toContain('const countersBefore = foldCounters(active)')
    expect(HOST).toMatch(/dEmergencies > 0 \? 'emergency' : dRoots > 0 \? 'root' : 'leaf'/u)
    // And the comment that records why, so the next reader does not look for `kind`.
    expect(HOST).toContain('has no `kind` field')
  })

  it('does not record a fold that threw', () => {
    // A failed fold commits nothing and is already counted by compactionFailures;
    // recording it here too would double-count it as an event that shadowed nothing.
    expect(HOST).toMatch(/if \(committed !== null && committed !== undefined\)/u)
    expect(HOST).toContain('foldLineage.push({')
  })

  it('emits it and resets it with the rest of the per-episode state', () => {
    expect(HOST).toMatch(/return \{\n    folds,\n    roots,\n    emergencies,\n    foldLineage,/u)
    expect(HOST).toContain('let foldLineage: FoldEvent[] = []')
    // Both are reset, but NOT asserted adjacent: the reset block gains a line whenever a new
    // piece of per-episode state is added, and pinning the layout made this test fail the
    // moment `compactionEnabled` was inserted between them. The intent is that the block
    // clears both, so that is what is checked -- each inside the reset region, either order.
    // Anchored on `init`, NOT on `turnCounter = 0`: that string also appears as a module-level
    // declaration earlier in the file, so indexOf found the declaration and the check read a
    // region that contains no reset at all -- it passed for the wrong reason until the block
    // was edited. `systemText = request.policy` is unique to init.
    const resetStart = HOST.indexOf('systemText = request.policy')
    const resetBlock = HOST.slice(resetStart, resetStart + 600)
    expect(resetBlock).toContain('foldLineage = []')
    expect(resetBlock).toContain('roots = 0')
  })
})
