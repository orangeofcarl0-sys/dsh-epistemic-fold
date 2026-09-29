/**
 * RC1-D: cache contract compliance, checked statically.
 *
 * Every rule here corresponds to a way the project could pay for a cache miss
 * it did not need. None of them requires a provider call to check, and all of
 * them are cheaper to assert on every push than to discover in a live bill —
 * which is the point of RC1 §27.
 *
 * The determinism check is the load-bearing one. It assembles the SAME session
 * state twice through the real production path and demands byte equality of the
 * stable portion. A timestamp, a random id, or an unordered iteration above the
 * cache boundary would fail it, and nothing else in the suite would notice.
 */

import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.ts'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { FOLD_FRAMING_SECTION } from '../src/framing.ts'
import {
  checkEfCacheContract,
  checkLeafMutatesLate,
  checkPrefixDeterminism,
  checkRootRarity,
  contractToMarkdown,
  sharedPrefixLength,
} from '../eval/src/cache-contract.ts'
import type { RequestShape } from '../eval/src/cache-contract.ts'
import { sha256Hex } from '../src/hash.ts'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { runPairedBaseline } from '../bench/paired-baseline.ts'
import { createIdleMaintenanceHook } from '../bench/paired-baseline.ts'
import { SIGNAL } from './harness.ts'

/** Assemble one request shape from a session, the way production would. */
async function shapeOf(harness: Awaited<ReturnType<typeof createHarness>>, session: SessionType): Promise<RequestShape> {
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string }[] }> }
    | undefined
  let system = ''
  let toolNames: readonly string[] = []
  if (service?.assemble !== undefined) {
    try {
      const assembly = await service.assemble({})
      system = (assembly.sections ?? []).map(section => section.text ?? '').join('\n\n')
      toolNames = (assembly.tools ?? []).map(tool => tool.name)
    } catch {
      // An absent assembly is a shape with no system prompt, which is honest.
    }
  }
  const messageDigests: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messageDigests.push(sha256Hex(JSON.stringify(message)))
  }
  return { system, toolNames, messageDigests }
}

describe('RC1-D: the stable prefix is byte-deterministic', () => {
  it('two assemblies of the SAME state are byte-identical', async () => {
    // The assertion RC1 §28 asks for. A timestamp, a random UUID, or a
    // non-deterministic tool-schema order above the cache boundary would break
    // reuse while being invisible to the model.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 32_000, workloadModel: WORKLOAD_MODEL,
      plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy', thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 2_000 },
    })
    const workload = allWorkloads()[0]!
    const session = workload.createSession()
    for (let step = 1; step <= 6; step += 1) workload.grow(session, step)

    const first = await shapeOf(harness, session)
    const second = await shapeOf(harness, session)
    const report = checkPrefixDeterminism(first, second)
    console.log(contractToMarkdown('prefix determinism', report))
    expect(report.compliant).toBe(true)
    // And the prefix is non-trivially long, so the check is not vacuous.
    expect(first.messageDigests.length).toBeGreaterThan(3)
  }, 300_000)

  it('DETECTS a non-deterministic prefix when one is injected', () => {
    // The negative control. Without it, "compliant" could mean the comparison
    // never fires — the vacuity failure this project has hit repeatedly.
    const base: RequestShape = { system: 'S', toolNames: ['a', 'b'], messageDigests: ['m1', 'm2'] }
    const withTimestamp: RequestShape = { system: 'S at 2026-09-29T12:00:00Z', toolNames: ['a', 'b'], messageDigests: ['m1', 'm2'] }
    const reordered: RequestShape = { system: 'S', toolNames: ['b', 'a'], messageDigests: ['m1', 'm2'] }
    const divergent: RequestShape = { system: 'S', toolNames: ['a', 'b'], messageDigests: ['m1', 'mX'] }

    expect(checkPrefixDeterminism(base, withTimestamp).violations[0]?.rule).toBe('system-determinism')
    expect(checkPrefixDeterminism(base, reordered).violations[0]?.rule).toBe('tool-order-determinism')
    expect(checkPrefixDeterminism(base, divergent).violations[0]?.rule).toBe('message-determinism')
    expect(checkPrefixDeterminism(base, base).compliant).toBe(true)
  })

  it('measures the shared prefix length, which is what a fold must maximize', () => {
    const previous: RequestShape = { system: 'S', toolNames: [], messageDigests: ['a', 'b', 'c', 'd'] }
    const appended: RequestShape = { system: 'S', toolNames: [], messageDigests: ['a', 'b', 'c', 'd', 'e'] }
    const rewritten: RequestShape = { system: 'S', toolNames: [], messageDigests: ['a', 'X', 'c', 'd'] }
    expect(sharedPrefixLength(previous, appended)).toBe(4)
    expect(sharedPrefixLength(previous, rewritten)).toBe(1)
  })
})

describe('RC1-D: the EF system section and tool order are cache-stable', () => {
  it('the framing section is CONSTANT and EARLY', async () => {
    // RC1 §29: `FOLD_FRAMING_SECTION` is a literal, so it should be static,
    // deterministic, and near the front of the prefix. DSH's own
    // `harness:identity` section legitimately precedes it and is constant, so
    // the contract is "before any deployment content", not "at index 0".
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 32_000, workloadModel: WORKLOAD_MODEL,
      plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy', thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 2_000 },
    })
    const session = allWorkloads()[0]!.createSession()
    const shape = await shapeOf(harness, session)
    expect(shape.system).toContain(FOLD_FRAMING_SECTION)

    // The section list is introspectable, so the bound is derived from what
    // actually precedes the framing section rather than assumed.
    const service = harness.ctx.get('systemPrompt') as unknown as
      | { assemble?: (context: unknown) => Promise<{ sections?: readonly { name?: string; text?: string }[] }> }
      | undefined
    const assembly = await service!.assemble!({})
    const sections = assembly.sections ?? []
    const framingIndex = sections.findIndex(section => section.name === 'epistemic-fold:checkpoints')
    expect(framingIndex).toBeGreaterThanOrEqual(0)
    // Everything ahead of the framing section must itself be constant. DSH's
    // identity preamble qualifies; a deployment persona would not.
    const ahead = sections.slice(0, framingIndex)
    const aheadNames = ahead.map(section => section.name)
    console.log(`EF framing section at index ${framingIndex}; ahead: [${aheadNames.join(', ')}]`)
    expect(ahead.every(section => section.name?.startsWith('harness:') === true)).toBe(true)

    const preamble = ahead.map(section => section.text ?? '').join('\n\n')
    const report = checkEfCacheContract(shape, {
      framingSection: FOLD_FRAMING_SECTION,
      constantPreamble: preamble,
    })
    console.log(contractToMarkdown('EF cache contract', report))
    expect(report.compliant).toBe(true)

    // And it IS constant across two assemblies, which is the property that
    // makes its position safe to depend on.
    const again = await shapeOf(harness, session)
    expect(again.system).toBe(shape.system)
  }, 300_000)

  it('a framing section buried behind session state FAILS the contract', () => {
    // The negative control for the "early" rule.
    const shape: RequestShape = {
      system: `session preamble that varies\n\n${FOLD_FRAMING_SECTION}`,
      toolNames: [],
      messageDigests: [],
    }
    const report = checkEfCacheContract(shape, { framingSection: FOLD_FRAMING_SECTION, framingMaxIndex: 0 })
    expect(report.compliant).toBe(false)
    expect(report.violations[0]?.rule).toBe('framing-not-early')
  })

  it('DETECTS a reordered recall-tool block', () => {
    const required = ['context_search', 'context_recall']
    const stable: RequestShape = { system: '', toolNames: ['read', 'context_search', 'context_recall'], messageDigests: [] }
    const flipped: RequestShape = { system: '', toolNames: ['read', 'context_recall', 'context_search'], messageDigests: [] }
    expect(checkEfCacheContract(stable, { requiredToolOrder: required }).compliant).toBe(true)
    const report = checkEfCacheContract(flipped, { requiredToolOrder: required })
    expect(report.compliant).toBe(false)
    expect(report.violations[0]?.rule).toBe('recall-tool-order')
  })
})

describe('RC1-D: a fold rewrites as LATE as possible, and a root stays rare', () => {
  it('a leaf that mutates BEFORE its own region is a violation', () => {
    // Rewriting a message the fold does not cover invalidates cache the model
    // had already priced, for no epistemic gain.
    expect(checkLeafMutatesLate(5, 5).compliant).toBe(true)
    expect(checkLeafMutatesLate(6, 5).compliant).toBe(true)
    const bad = checkLeafMutatesLate(2, 5)
    expect(bad.compliant).toBe(false)
    expect(bad.violations[0]?.rule).toBe('leaf-mutates-late')
  })

  it('roots must stay rare relative to leaf folds', () => {
    expect(checkRootRarity(1, 20).compliant).toBe(true)
    const thrash = checkRootRarity(12, 20)
    expect(thrash.compliant).toBe(false)
    expect(thrash.violations[0]?.rule).toBe('root-rarity')
    // A manual `/compact` with no leaves is not thrash.
    expect(checkRootRarity(3, 0).compliant).toBe(true)
  })

  it('the production economy arm keeps its fold geometry within contract', async () => {
    // End-to-end: run the real plugin and assert the fold geometry, so the
    // contract is measured on a trajectory rather than only on synthetic
    // shapes.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 8_000, workloadModel: WORKLOAD_MODEL,
      plugin: true, systemPrompt: true,
      efConfig: {
        thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 1_500,
        leafAdmission: 'economic', rootPolicy: 'economics',
        semanticMode: 'none', framingMode: 'system-dedup',
      },
    })
    const workload = allWorkloads()[2]!
    const result = await runPairedBaseline({
      arm: 'contract', harness, createSession: workload.createSession, steps: 40,
      grow: (session: SessionType, step: number) => workload.grow(session, step),
      rebase: createIdleMaintenanceHook(harness),
      signal: SIGNAL,
    })
    // Vacuity guard: a run that never folded proves nothing about fold geometry.
    expect(result.leafFoldCount).toBeGreaterThan(3)

    const rarity = checkRootRarity(result.rootFoldCount, result.leafFoldCount)
    console.log(contractToMarkdown(
      `root rarity (${result.rootFoldCount} roots / ${result.leafFoldCount} leaves)`,
      rarity,
    ))
    expect(rarity.compliant).toBe(true)

    // Every step's post-fold surface must not exceed its pre-fold high-water
    // mark: a "fold" that grew the surface is not a fold.
    for (const sample of result.samples) {
      expect(sample.promptTokens).toBeLessThanOrEqual(sample.preFoldTokens)
    }
    console.log(
      `CONTRACT geometry: leaves=${result.leafFoldCount} roots=${result.rootFoldCount} `
      + `peakRatio=${(result.peaks.mainRequestPeak / result.peaks.surfacePeak).toFixed(3)}`,
    )
  }, 600_000)
})
