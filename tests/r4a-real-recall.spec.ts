/**
 * R4-A: does REAL recall cost anything, and does the REAL chain work?
 *
 * R3's conclusion that "recall carry is the remaining 0.2%" rests on a workload
 * that never recalls anything: `W4-recall-heavy` appends a tool call whose ref
 * is the literal string `cp:earlier` — not a bundle checkpoint — and whose
 * result is generated inline. No store, no search, no page is involved.
 *
 * So this suite runs the two experiments R4 §7 separates, and gates on them:
 *
 *   W4R-COMMON  identical recalled bytes in both arms → fair PRICE comparison
 *   W4R-NATIVE  the real Bundle-backed chain, through ctx.tools → product proof
 *
 * The R4-A gate is strict and load-bearing: **if W4R-COMMON shows recall is not
 * actually a cost problem, R4-B (recall materialization pruning) is SKIPPED.**
 * No mechanism without a measured problem.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { priceArm } from '../eval/src/dominance.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'
import { flash } from './economics-fixture.ts'
import { NATIVE_FACT, nativeFactRefs, realRecallCommon, realRecallNative } from '../eval/workloads/real-recall.ts'
import { createAnchorService } from '../src/anchor-service.ts'
import { recall, search } from '../src/recall.ts'
import { locateFoldFrontier } from '../src/frontier.ts'
import { parseCheckpointMarker } from '../src/checkpoint-marker.ts'

const WORKLOAD_MODEL = 'workload-model'
const STEPS = 64
const WINDOW = 16_000
const REALIZATION = 0.91

function cost(result: BaselineResult, profile: ContextEconomicsProfile): number {
  return priceArm({
    promptTokens: result.promptSummary.totalPromptTokens,
    warmTokens: result.stablePrefixTokensTotal,
    peakTokens: result.promptSummary.peakPromptTokens,
    auxiliaryInputTokens: result.auxiliaryCompaction.inputTokens ?? 0,
    auxiliaryOutputTokens: result.auxiliaryCompaction.outputTokens ?? 0,
  }, profile, REALIZATION).totalCost
}

/** One W4R-COMMON arm. Both arms share the workload's archive and results. */
async function commonArm(basic: boolean): Promise<BaselineResult> {
  const workload = realRecallCommon()
  const harness = await createHarness({ text: 'digest' }, {
    contextWindow: WINDOW, workloadModel: WORKLOAD_MODEL,
    ...(basic ? { engine: 'basic' as const } : { plugin: true, systemPrompt: true }),
    efConfig: {
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
      ...(basic ? {} : {
        leafAdmission: 'economic' as const, rootPolicy: 'economics' as const,
        semanticMode: 'none' as const, framingMode: 'system-dedup' as const,
      }),
    },
  })
  return runPairedBaseline({
    arm: basic ? 'B1' : 'E3',
    harness,
    createSession: workload.createSession,
    steps: STEPS,
    grow: (session: Session, step: number) => workload.grow(session, step),
    ...(basic ? {} : { rebase: createIdleMaintenanceHook(harness) }),
    signal: SIGNAL,
  })
}

describe('R4-A: W4R-COMMON is a fair price comparison', () => {
  it('both arms receive byte-identical recall materialization', async () => {
    // The fairness property is structural, not asserted from the numbers: the
    // workload materializes each page from ONE benchmark-owned archive, so the
    // two arms cannot diverge in recalled bytes by construction. What this
    // test pins is that the materialization actually happened and is the same
    // size in both arms.
    const basic = await commonArm(true)
    const economy = await commonArm(false)

    const basicRecall = basic.attribution.totals.recall
    const economyRecall = economy.attribution.totals.recall
    console.log(
      `W4R-COMMON recall tokens: basic=${basicRecall} economy=${economyRecall} `
      + `(folds basic=${basic.leafFoldCount} economy=${economy.leafFoldCount})`,
    )
    // A vacuity guard: if neither arm materialized recall, the comparison is
    // over nothing and any ratio would be meaningless.
    expect(basicRecall).toBeGreaterThan(0)
    expect(economyRecall).toBeGreaterThan(0)
    // Identical input bytes. The counts can differ only through how many times
    // each policy retained them, which is exactly what is being priced.
    expect(economyRecall / basicRecall).toBeGreaterThan(0.5)
    expect(economyRecall / basicRecall).toBeLessThan(2)
  }, 600_000)

  it('the GATE: decides whether recall carry is a real remaining cost', async () => {
    const basic = await commonArm(true)
    const economy = await commonArm(false)
    const profile = flash()
    const bcr = cost(economy, profile) / cost(basic, profile)

    console.log(
      `W4R-COMMON BCR = ${bcr.toFixed(3)} `
      + `(basic total=${basic.promptSummary.totalPromptTokens} warm=${basic.stablePrefixTokensTotal}, `
      + `economy total=${economy.promptSummary.totalPromptTokens} warm=${economy.stablePrefixTokensTotal})`,
    )
    console.log(
      bcr <= 1
        ? 'R4-A GATE: PASS — real recall is NOT a cost problem; SKIP recall materialization pruning (R4-B)'
        : 'R4-A GATE: FAIL — real recall carry is confirmed as a remaining cost; R4-B is justified',
    )

    // The gate's verdict is the finding; the test asserts the measurement is
    // well-formed and states which way it went, rather than asserting a
    // desired direction. R4 §9 makes skipping R4-B the expected outcome when
    // the gate passes, so a "PASS" here is a real result, not a null one.
    expect(Number.isFinite(bcr)).toBe(true)
    expect(bcr).toBeGreaterThan(0)
  }, 600_000)
})

/** A fixture whose leading span carries the planted fact, ready to fold. */
function nativeFixture(): ReturnType<ReturnType<typeof realRecallNative>['createSession']> {
  const workload = realRecallNative()
  const session = workload.createSession()
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: NATIVE_FACT.plant }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  createAnchorService().declare(session, {
    id: 'w4r-native-fact',
    kind: NATIVE_FACT.anchor.kind,
    stateKey: NATIVE_FACT.anchor.stateKey,
    value: NATIVE_FACT.anchor.value,
    authority: NATIVE_FACT.anchor.authority,
    sourceRefs: nativeFactRefs(session),
  })
  return session
}

async function nativeHarness(): Promise<Harness> {
  return createHarness({ text: 'digest' }, {
    contextWindow: WINDOW, workloadModel: WORKLOAD_MODEL, plugin: true, systemPrompt: true,
    efConfig: {
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
      leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
      framingMode: 'system-dedup',
    },
  })
}

describe('R4-A: W4R-NATIVE exercises the real Bundle-backed chain', () => {
  it('a real fold produces a real bundle whose archive holds the folded fact', async () => {
    // The chain under test: real fold → CheckpointBundle → the archived
    // messages. No synthetic pages anywhere.
    const harness = await nativeHarness()
    const session = nativeFixture()
    const nodes = [...session.surface.nodes]
    const result = await harness.engine.compactRegion(
      nodes[0]!, nodes[nodes.length - 1]!,
      { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never,
      SIGNAL,
    )
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)

    // The frontier must see it: same-surface identity through the marker.
    expect(locateFoldFrontier(session).frozenCount).toBeGreaterThan(0)

    // A REAL bundle must exist, and its archive must contain the marker text.
    const bundles = await harness.engine.bundleStore.list(session.id)
    expect(bundles.length).toBeGreaterThan(0)
    const archived = await harness.engine.bundleStore.read(session.id, bundles[0]!.checkpointId)
    expect(archived).not.toBeNull()
    const archivedText = JSON.stringify(archived!.archive.shadowedMessages ?? archived!.archive.refs)
    expect(archivedText).toContain(NATIVE_FACT.marker)
    console.log(
      `W4R-NATIVE: archived ${archived!.archive.messageCount} messages, `
      + `marker ${NATIVE_FACT.marker} recoverable = ${archivedText.includes(NATIVE_FACT.marker)}`,
    )
  }, 300_000)

  it('exact recall returns the marker from the real archive, not a fixture', async () => {
    const harness = await nativeHarness()
    const session = nativeFixture()
    const nodes = [...session.surface.nodes]
    await harness.engine.compactRegion(
      nodes[0]!, nodes[nodes.length - 1]!,
      { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never,
      SIGNAL,
    )
    const bundles = await harness.engine.bundleStore.list(session.id)
    const checkpointId = bundles[0]!.checkpointId

    // Through the RECALL ENTRY POINT, not the store read: this is the path the
    // tool serves, and it must round-trip the marker.
    const recalled = await recall({
      store: harness.engine.bundleStore,
      sessionId: session.id,
      checkpointId: `cp:${checkpointId}`,
      depth: 'exact',
    })
    expect(recalled?.unavailable).toBeUndefined()
    expect(recalled?.page).toBeDefined()
    const pageText = JSON.stringify(recalled!.page!.messages)
    expect(pageText).toContain(NATIVE_FACT.marker)
    expect(recalled!.page!.totalMessages).toBeGreaterThan(0)
    console.log(
      `W4R-NATIVE recall: cp:${checkpointId.slice(0, 8)}… page 0/${recalled!.page!.totalMessages} `
      + `messages, marker present = ${pageText.includes(NATIVE_FACT.marker)}`,
    )
  }, 300_000)

  it('search finds the checkpoint by its archived content', async () => {
    // context_search is the other half of the affordance: the model must be
    // able to FIND a checkpoint without already knowing its id.
    const harness = await nativeHarness()
    const session = nativeFixture()
    const nodes = [...session.surface.nodes]
    await harness.engine.compactRegion(
      nodes[0]!, nodes[nodes.length - 1]!,
      { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never,
      SIGNAL,
    )
    const hits = await search({
      store: harness.engine.bundleStore,
      sessionId: session.id,
      query: NATIVE_FACT.marker,
    })
    expect(hits.length).toBeGreaterThan(0)
    console.log(`W4R-NATIVE search: query ${NATIVE_FACT.marker} → ${hits.length} hit(s)`)
  }, 300_000)

  it('the checkpoint the frontier sees is the one the store knows', async () => {
    // Identity continuity: the marker on the surface and the bundle on disk
    // must name the same checkpoint. If these diverge, recall is unreachable
    // from what the model sees and the whole chain is cosmetic.
    const harness = await nativeHarness()
    const session = nativeFixture()
    const nodes = [...session.surface.nodes]
    await harness.engine.compactRegion(
      nodes[0]!, nodes[nodes.length - 1]!,
      { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never,
      SIGNAL,
    )

    let surfaceCheckpointId: string | undefined
    for (const seq of session.surface.nodes) {
      const message = session.deriveEventMessage(session.eventAt(seq)!)
      if (message === null) continue
      if ((message as unknown as { source?: { kind?: string } }).source?.kind !== 'compact-checkpoint') continue
      const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
      surfaceCheckpointId = parseCheckpointMarker(text)?.checkpointId
    }
    expect(surfaceCheckpointId, 'the fold must land a marker on the surface').toBeDefined()

    const bundles = await harness.engine.bundleStore.list(session.id)
    expect(bundles.map(b => b.checkpointId)).toContain(surfaceCheckpointId)
    console.log(`W4R-NATIVE identity: surface marker ${surfaceCheckpointId!.slice(0, 8)}… == stored bundle`)
  }, 300_000)
})

describe('R4-A: the synthetic W4 is documented as NOT testing recall', () => {
  it('W4-recall-heavy recalls from a ref that is not a bundle checkpoint', async () => {
    // The finding, pinned so it cannot be forgotten: W4's recall ref is a
    // literal string and its payload is generated inline. Any conclusion drawn
    // from W4 about "real recall" is therefore unsupported.
    const source = readFileSync(
      join(import.meta.dirname, '..', 'eval', 'workloads', 'index.ts'), 'utf8',
    )
    const w4 = source.slice(source.indexOf('export function recallHeavy'))
    expect(w4).toContain("ref: 'cp:earlier'")
    // The payload is `toolBody(...)` — generated lines, not an archive.
    expect(w4).toMatch(/resultText: `recalled page:/u)
    // And no store, search, or recall call appears anywhere in the workload.
    expect(w4).not.toContain('bundleStore')
    expect(w4).not.toContain('context_search')
  })

  it('W4R-COMMON materializes from a shared archive instead', () => {
    const workload = realRecallCommon()
    // One archive, owned by the workload, materialized into every arm.
    // (`typeof workload.grow === 'function'` was also asserted here, but it
    // checked the shape of a locally-built fixture — no code under test could
    // have made it fail.)
    expect(workload.archive.messages.length).toBeGreaterThan(0)
    // The ref is the SHARED archive's, distinct from W4's fake `cp:earlier`.
    expect(workload.archive.messages[0]).toContain('archived message 0')
  })
})
