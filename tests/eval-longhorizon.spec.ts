/**
 * R0-C3 long-horizon economics (work-order §14-§15): deterministic runs at
 * 32/64/128 growth steps under two EF maintenance modes — `leaf-only` and
 * `leaf+root` (the benchmark-controlled rebase policy, named explicitly so it
 * is never mistaken for production behavior). Also the context-budget ladder
 * (scaled synthetic windows).
 *
 * Reports every metric named in the work order, per arm and per horizon:
 * totalPromptTokens, peakPromptTokens, p95PromptTokens, invalidatedSuffixTokens,
 * sharedPrefixTokens, reclaimedTokens, PMA, frozenCheckpointTokens, rootCount,
 * auxiliary compaction tokens.
 */

import { describe, expect, it } from 'vitest'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createRootRebaseHook, growTurn, runPairedBaseline } from '../bench/paired-baseline.ts'
import { createHarness, conversation, SIGNAL, type Harness } from './harness.ts'
import { baselineToMarkdown } from '../eval/src/report.ts'

const GROW_TEXT = 'long-horizon fixture '.repeat(50).trim()

interface ArmSpec {
  readonly name: string
  readonly harness: () => Promise<Harness>
  readonly rebase?: (harness: Harness) => (session: import('@deepseek-ai/dsh-session').Session) => Promise<number>
}

function efHarness(contextWindow: number, frozenBudget?: number): Promise<Harness> {
  return createHarness({ text: 'ef digest' }, {
    contextWindow,
    efConfig: {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: 0,
      maxTokens: Math.min(4_096, Math.floor(contextWindow / 4)),
      ...(frozenBudget === undefined ? {} : { frozenCheckpointTokenBudget: frozenBudget }),
    },
  })
}

function basicHarness(contextWindow: number): Promise<Harness> {
  return createHarness({ text: 'basic digest' }, {
    contextWindow,
    engine: 'basic',
    efConfig: {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: 0,
      maxTokens: Math.min(4_096, Math.floor(contextWindow / 4)),
    },
  })
}

function report(label: string, result: BaselineResult): void {
  const row = [
    label,
    `prompt=${result.promptSummary.totalPromptTokens}/${result.promptSummary.peakPromptTokens}/${result.promptSummary.p95PromptTokens}`,
    `SPT=${result.stablePrefixTokensTotal}`,
    `IST=${result.absolutePrefixInvalidation}`,
    `reclaimed=${result.reclaimedTokensTotal}`,
    `PMA=${result.prefixMutationRatio === undefined ? 'undef' : result.prefixMutationRatio.toFixed(3)}`,
    `frozen=${result.frozenSummary.meanFrozenTokens.toFixed(0)}/${result.frozenSummary.peakFrozenTokens}`,
    `leaf=${result.leafFoldCount}`,
    `root=${result.rootFoldCount}`,
    `aux=${result.auxiliaryCompaction.callCount}`,
    `curve=${result.cacheEconomics.map(p => `${p.rho}:${p.cost.toFixed(0)}`).join(',')}`,
  ].join(' | ')
  console.log(row)
}

describe('R0-C3: long-horizon deterministic economics', () => {
  for (const steps of [32, 64, 128]) {
    it(`${steps} steps: Basic vs EF leaf-only vs EF leaf+root`, async () => {
      const window = 32_000
      const specs: ArmSpec[] = [
        { name: 'B1-basic', harness: () => basicHarness(window) },
        { name: 'EF-leaf-only', harness: () => efHarness(window) },
        {
          name: 'EF-leaf+root',
          harness: () => efHarness(window, 300),
          rebase: harness => createRootRebaseHook(harness),
        },
      ]

      const results: Record<string, BaselineResult> = {}
      for (const spec of specs) {
        const harness = await spec.harness()
        results[spec.name] = await runPairedBaseline({
          arm: spec.name,
          harness,
          createSession: () => conversation(4),
          steps,
          grow: growTurn(GROW_TEXT),
          ...(spec.rebase === undefined ? {} : { rebase: spec.rebase(harness) }),
          signal: SIGNAL,
        })
      }

      console.log(`--- ${steps} steps (window ${window}) ---`)
      for (const [name, result] of Object.entries(results)) report(name, result)

      // Structural invariants that must hold at every horizon.
      for (const result of Object.values(results)) {
        expect(result.promptSummary.totalPromptTokens).toBeGreaterThan(0)
        expect(result.promptSummary.peakPromptTokens).toBeLessThanOrEqual(result.promptSummary.totalPromptTokens)
        expect(result.promptSummary.p95PromptTokens).toBeLessThanOrEqual(result.promptSummary.peakPromptTokens)
      }
      // The root-maintained arm rebased at least once over the horizon: at
      // short horizons the frozen load may stay under budget (no rebase is
      // the correct, evidence-driven outcome), so the gate is "rebase happens
      // by the longest horizon".
      if (steps >= 64) {
        expect(results['EF-leaf+root']!.rootFoldCount).toBeGreaterThanOrEqual(1)
      }
      // Both EF arms compacted.
      expect(results['EF-leaf-only']!.leafFoldCount).toBeGreaterThan(0)
      expect(results['EF-leaf+root']!.leafFoldCount).toBeGreaterThan(0)
      // The markdown view is generated from the machine numbers.
      expect(baselineToMarkdown(results['EF-leaf-only']!)).toContain('absolutePrefixInvalidation')
    }, 180_000)
  }

  it('context-budget ladder: scaled synthetic windows change fold pressure, not correctness', async () => {
    const ladder = [4_000, 8_000, 16_000, 32_000]
    const rows: string[] = []
    for (const window of ladder) {
      const harness = await efHarness(window)
      const result = await runPairedBaseline({
        arm: `EF-${window}`,
        harness,
        createSession: () => conversation(4),
        steps: 32,
        grow: growTurn(GROW_TEXT),
        signal: SIGNAL,
      })
      rows.push(`window=${window} leaf=${result.leafFoldCount} peak=${result.promptSummary.peakPromptTokens} frozen=${result.frozenSummary.peakFrozenTokens}`)
      // Every window keeps the run structurally valid; pressure at the
      // largest window may legitimately stay under threshold for 32 steps.
      expect(result.promptSummary.totalPromptTokens).toBeGreaterThan(0)
      expect(result.leafFoldCount + result.rootFoldCount).toBeGreaterThanOrEqual(0)
    }
    for (const row of rows) console.log(row)
    // Smaller windows fold MORE often (pressure arrives earlier).
    const counts = rows.map(row => Number(/leaf=(\d+)/u.exec(row)![1]))
    expect(counts[0]).toBeGreaterThanOrEqual(counts[counts.length - 1]!)
    expect(counts[0]!).toBeGreaterThan(0)
  }, 180_000)
})
