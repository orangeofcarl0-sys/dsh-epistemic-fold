/**
 * R4-0a: four baseline corrections that had to land before any product claim.
 *
 * None of these adds a mechanism. Each closes a place where the project's own
 * record disagreed with its code, its code swallowed a defect, or its
 * explanation of a measured number was simply wrong.
 *
 * 1. `RebaseIntentRegistry` documented id-keying while implementing weak
 *    object-identity keying. The implementation is right (a `Map<SessionId,…>`
 *    would be a lifecycle leak); the documentation was wrong.
 * 2. `settled()` exited SILENTLY past its drain cap, reporting "settled" for a
 *    consumer that might still be churning — the exact idle→rebase→idle loop
 *    the one-shot intent exists to prevent.
 * 3. R3 explained the peak-context gap as "the fold is appended but the
 *    replacement has not yet reduced the surface". The measurement is taken
 *    AFTER the awaited fold, so that explanation was wrong. The real cause is
 *    fold-cadence quantization, and it is measured here.
 * 4. The framing seam is a vendored patch. R4 requires it be a supported
 *    dependency with an explicit contract, and forbids runtime sniffing.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import { createRebaseIntentRegistry, intentMatchesSession } from '../src/rebase-intent.ts'
import { SETTLE_ROUND_LIMIT, registerIdleRebaseConsumer } from '../src/idle-rebase.ts'
import {
  evaluateWindowSafety,
  peakRatioDiagnostic,
  windowSafetyToMarkdown,
} from '../eval/src/window-safety.ts'
import { assertDshCompatibility, detectDshCapabilities, framingModeSupported } from '../src/compat.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

describe('R4-0a: the intent registry keys on live Session identity', () => {
  it('a DIFFERENT object with the SAME session id does not share an intent', () => {
    // This is the documented contract, made executable. It is also why a
    // Map<SessionId, …> would be wrong: id keys would alias distinct sessions
    // across a restart and would retain every intent for the process lifetime.
    const registry = createRebaseIntentRegistry()
    const live = { id: 'sess-1' as SessionId }
    const clone = { id: 'sess-1' as SessionId }
    registry.set(live, {
      sessionId: 'sess-1' as SessionId,
      preparedGeneration: 1,
      cause: 'frozen_budget',
      createdAtSeq: 1 as never,
    })
    expect(registry.peek(live)).toBeDefined()
    expect(registry.peek(clone)).toBeUndefined()
  })

  it('the recorded sessionId is re-verified before acting (fail-closed audit)', () => {
    // The id is not the lookup key; it is the guard that stops a mis-keyed
    // intent from rebasing the wrong conversation.
    const intent = {
      sessionId: 'sess-a' as SessionId, preparedGeneration: 1, cause: 'frozen_budget' as const, createdAtSeq: 1 as never,
    }
    expect(intentMatchesSession(intent, 'sess-a' as SessionId)).toBe(true)
    expect(intentMatchesSession(intent, 'sess-b' as SessionId)).toBe(false)
  })
})

describe('R4-0a: settled() fails LOUD rather than capping a loop', () => {
  it('refuses to describe a self-sustaining loop as settled', async () => {
    // The loop is driven with a STUB engine, so the test isolates the drain
    // contract instead of racing the plugin's own consumer for the one-shot
    // intent (which lives on the same `agent/status` event).
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 16_000, workloadModel: WORKLOAD_MODEL,
      efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000 },
    })
    const session = allWorkloads()[0]!.createSession()
    const sessionId = session.id
    let rounds = 0
    const churningEngine = {
      rebaseIntentRegistry: createRebaseIntentRegistry(),
      // Always justify a root, and never actually perform one, so the only
      // thing that can stop the chain is the drain cap.
      rebaseDecisionAtIdle: async () => ({
        regime: 'token-dominant' as const, action: 'root' as const,
        leafRepresentation: 'snapshot' as const, semanticMode: 'none' as const,
        estimatedCost: 0, overridden: false, reason: 'stub: always rebase',
      }),
      compactNow: async () => {
        rounds += 1
        // Re-arm and re-emit from inside the consumer: the self-sustaining
        // pattern. Without re-arming, the one-shot consume stops it and there
        // is nothing to detect.
        churningEngine.rebaseIntentRegistry.set(session, {
          sessionId, preparedGeneration: 0, cause: 'frozen_budget', createdAtSeq: 0 as never,
        })
        harness.ctx.emit('agent/status', {
          agent: { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never,
          status: 'idle',
        })
        // A non-null result, so the consumer reports `rebased` and continues.
        return { shadowedSeqs: [], startSeq: 0, summarySeq: 0, endSeq: 0, compactionId: 'x' }
      },
    } as unknown as Parameters<typeof registerIdleRebaseConsumer>[0]['engine']

    const registration = registerIdleRebaseConsumer({
      ctx: harness.ctx, engine: churningEngine, intents: churningEngine.rebaseIntentRegistry,
    })
    churningEngine.rebaseIntentRegistry.set(session, {
      sessionId, preparedGeneration: 0, cause: 'frozen_budget', createdAtSeq: 0 as never,
    })
    harness.ctx.emit('agent/status', {
      agent: { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never,
      status: 'idle',
    })
    await expect(registration.settled()).rejects.toThrow(/did not settle|idle→rebase→idle/u)
    // The cap was genuinely reached, so the throw reports a real loop rather
    // than a slow consumer.
    expect(rounds).toBeGreaterThanOrEqual(SETTLE_ROUND_LIMIT)
    registration.dispose()
  }, 120_000)
})

describe('R4-0a: the peak gap is fold-cadence quantization, not a measurement artifact', () => {
  /**
   * The corrected explanation, measured rather than asserted.
   *
   * Both arms fold the SAME number of times and reclaim nearly the same amount
   * per fold, so the R3 story ("mid-transaction artifact") and the naive story
   * ("EF folds later") are both wrong. What differs is the POST-FOLD FLOOR: EF
   * leaves a slightly smaller surface behind, so the same per-step growth takes
   * ONE MORE append to cross the same threshold. Crossing on a larger multiple
   * of the step quantum is what raises the peak.
   *
   * This is a property of any threshold-plus-quantum policy, not a defect, and
   * it is why R4-C replaces the 1.05x ratio with a window-safety gate: the
   * ratio grows without bound if the step is coarse, while the absolute
   * overshoot stays trivial against a real context window.
   */
  it('a lower post-fold floor needs more appends to cross, raising the overshoot', async () => {
    const steps = 30
    const run = async (basic: boolean) => {
      const workload = allWorkloads()[0]!
      const harness = await createHarness({ text: 'digest' }, {
        contextWindow: 16_000, workloadModel: WORKLOAD_MODEL,
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
        arm: basic ? 'B1' : 'E3', harness, createSession: workload.createSession, steps,
        grow: (session: Session, step: number) => workload.grow(session, step),
        ...(basic ? {} : { rebase: createIdleMaintenanceHook(harness) }),
        signal: SIGNAL,
      })
    }

    const basic = await run(true)
    const economy = await run(false)

    // Both arms fold repeatedly — a comparison over an unfolded surface proves
    // nothing (the vacuity guard lesson from R1/R2/R3).
    expect(basic.leafFoldCount).toBeGreaterThan(3)
    expect(economy.leafFoldCount).toBeGreaterThan(3)

    // The peak is a POST-FOLD surface, so it can never exceed the pre-fold
    // high-water mark: the fold already happened when it was measured.
    for (const sample of [...basic.samples, ...economy.samples]) {
      expect(sample.promptTokens).toBeLessThanOrEqual(sample.preFoldTokens)
    }

    const basicFloor = Math.min(...basic.samples.map(s => s.promptTokens).filter(t => t > 0))
    const economyFloor = Math.min(...economy.samples.map(s => s.promptTokens).filter(t => t > 0))
    const threshold = economy.thresholdTokens
    expect(threshold).toBeGreaterThan(0)

    // The mechanism, stated as the inequality that produces it: EF's floor is
    // lower, so it needs MORE appends to cross the same threshold, so its
    // crossing overshoots further.
    const overshoot = (floor: number, quantum: number): number => {
      let value = floor
      let appends = 0
      while (value <= threshold && appends < 1_000) {
        value += quantum
        appends += 1
      }
      return appends
    }
    // The quantum is the per-step APPEND size, identical across arms because
    // both are driven by the same `grow`. It is measured as the pre-fold delta
    // between steps that did not fold — NOT as `preFold - promptTokens`, which
    // is one step's reclaim and a different quantity.
    const preFold = basic.samples.map(sample => sample.preFoldTokens)
    const growth: number[] = []
    for (let index = 1; index < preFold.length; index += 1) {
      const delta = preFold[index]! - preFold[index - 1]!
      if (delta > 0) growth.push(delta)
    }
    const quantum = Math.min(...growth)
    console.log(
      `floors: basic=${basicFloor} economy=${economyFloor} (delta ${basicFloor - economyFloor}); `
      + `appends to cross ${threshold}: basic=${overshoot(basicFloor, quantum)} `
      + `economy=${overshoot(economyFloor, quantum)}`,
    )
    expect(economyFloor).toBeLessThan(basicFloor)
    expect(overshoot(economyFloor, quantum)).toBeGreaterThanOrEqual(overshoot(basicFloor, quantum))

    // And it stays ABSOLUTELY small: the ratio is alarming, the tokens are not.
    console.log(
      `peaks: basic=${basic.peaks.mainRequestPeak} economy=${economy.peaks.mainRequestPeak} `
      + `(ratio ${(economy.peaks.mainRequestPeak / basic.peaks.mainRequestPeak).toFixed(3)}, `
      + `absolute delta ${economy.peaks.mainRequestPeak - basic.peaks.mainRequestPeak} tokens)`,
    )
  }, 300_000)

  it('reports the three peaks separately instead of one conflated number', async () => {
    const workload = allWorkloads()[2]!
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 16_000, workloadModel: WORKLOAD_MODEL, plugin: true, systemPrompt: true,
      efConfig: {
        thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
        leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
        framingMode: 'system-dedup',
      },
    })
    const run = await runPairedBaseline({
      arm: 'E3', harness, createSession: workload.createSession, steps: 24,
      grow: (session: Session, step: number) => workload.grow(session, step),
      rebase: createIdleMaintenanceHook(harness), signal: SIGNAL,
    })
    // main == postFold: the measurement is taken after the awaited fold, so what
    // it prices is what the model would be sent. They are the SAME number, and
    // keeping both names makes that identity explicit rather than implicit.
    expect(run.peaks.mainRequestPeak).toBe(run.peaks.postFoldPeak)
    // The surface peak is the pre-fold high-water mark, so it is strictly
    // larger whenever any fold ran at all.
    expect(run.peaks.surfacePeak).toBeGreaterThan(run.peaks.mainRequestPeak)
    expect(run.peaks.meanFoldReclaim).toBeGreaterThan(0)
    console.log(`peaks: ${JSON.stringify(run.peaks)}`)
  }, 300_000)
})

describe('R4-0a: the framing seam is a supported dependency with an explicit contract', () => {
  it('the plugin refuses system-dedup without the seam, instead of silently not deduping', () => {
    // R4 §3/§4: a user who installs vanilla DSH and sets `framingMode:
    // system-dedup` must NOT silently get no dedup. The failure has to be
    // visible. This is checked by construction — the seam is a compile-time
    // dependency of the engine, so the capability check is a version contract,
    // never a runtime property sniff.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'engine.ts'), 'utf8')
    // No `if ((Basic as any).frameCheckpoint)`-style compatibility shims.
    expect(source).not.toMatch(/Basic[^\n]*as any/u)
    expect(source).not.toMatch(/typeof\s+\(?super\.frameCheckpoint/u)
    // The override is a real `super` call, which only typechecks when the seam
    // exists in the vendored declarations.
    expect(source).toContain('super.frameCheckpoint(')
  })

  it('the seam ships as an applying script whose edits are verified', () => {
    const script = readFileSync(
      join(import.meta.dirname, '..', 'scripts', 'apply-framing-seam.mjs'), 'utf8',
    )
    // The script must fail loudly when the vendored baseline has drifted, so a
    // partially-applied seam can never masquerade as a working one.
    expect(script).toContain('ANCHOR NOT FOUND')
    expect(script).toContain('process.exit(1)')
    // Documentation faces live in upstream-gitignored lib/, which is exactly
    // why a plain patch was insufficient.
    expect(script).toContain('lib')
  })
})

describe('R4-C: window safety replaces the peak ratio as the gate', () => {
  it('a run whose worst-case request fits with headroom is safe', () => {
    const verdict = evaluateWindowSafety({
      peakMainRequestTokens: 40_000,
      contextWindow: 131_072,
      reservedOutputTokens: 8_000,
      safetyHeadroomTokens: 16_384,
      overflowEvents: 0,
    })
    expect(verdict.safe).toBe(true)
    expect(verdict.requiredTokens).toBe(64_384)
    expect(verdict.windowUtilization).toBeLessThan(0.6)
  })

  it('an observed overflow fails the gate even when the peak would have fit', () => {
    // A recovered overflow still produced a retried or truncated turn, so a
    // clean worst-case fit does not excuse it.
    const verdict = evaluateWindowSafety({
      peakMainRequestTokens: 20_000,
      contextWindow: 131_072,
      reservedOutputTokens: 8_000,
      safetyHeadroomTokens: 16_384,
      overflowEvents: 1,
    })
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain('context-overflow')
  })

  it('a request that cannot fit its own window fails, and says by how much', () => {
    const verdict = evaluateWindowSafety({
      peakMainRequestTokens: 120_000,
      contextWindow: 131_072,
      reservedOutputTokens: 8_000,
      safetyHeadroomTokens: 16_384,
      overflowEvents: 0,
    })
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain('144384')
  })

  it('the ratio is a diagnostic with no gate attached', () => {
    // R3's 1.05x bound is NOT a gate here: EF carrying a longer context more
    // cheaply is the product, not a defect. The ratio is reported so a change
    // in fold timing stays visible.
    expect(peakRatioDiagnostic(2375, 2043)).toBeCloseTo(1.163, 3)
    expect(peakRatioDiagnostic(100, 0)).toBeUndefined()
    // A ratio far above the old bound is not by itself a failure.
    const verdict = evaluateWindowSafety({
      peakMainRequestTokens: 2_375,
      contextWindow: 131_072,
      reservedOutputTokens: 8_000,
      safetyHeadroomTokens: 16_384,
      overflowEvents: 0,
    })
    expect(verdict.safe).toBe(true)
    expect(peakRatioDiagnostic(2375, 2043)).toBeGreaterThan(1.05)
    // ...and the report states the verdict without ever showing the ratio as a
    // pass/fail criterion.
    expect(windowSafetyToMarkdown(verdict)).toContain('Window safe: **PASS**')
  })
})

describe('R4 §4: the seam is a capability CONTRACT, not a runtime sniff', () => {
  it('detects the seam in the base class EF extends', () => {
    // RC7: the base class is EF's own vendored copy, so this asserts the
    // VENDORING carries the seam — the thing that lets a tier mount on a DSH
    // build that ships none. If this ever reports false, every system-dedup
    // measurement becomes suspect, which is why the capability is asserted.
    expect(detectDshCapabilities().frameCheckpointSeam).toBe(true)
  })

  it('legacy framing needs NO seam, so the default mounts anywhere', () => {
    expect(() => assertDshCompatibility('legacy', { frameCheckpointSeam: false })).not.toThrow()
    expect(framingModeSupported({ frameCheckpointSeam: false }).legacy).toBe(true)
  })

  it('system-dedup WITHOUT the seam FAILS LOUD — it never silently degrades', () => {
    // R4 §3: a user who sets system-dedup must not get no dedup while
    // believing otherwise, which would report a saving that does not exist.
    // The error must name the capability. RC7 changed the remedy: the seam is
    // EF's own now, so a missing one means a broken vendoring, not a DSH the
    // user must patch.
    expect(() => assertDshCompatibility('system-dedup', { frameCheckpointSeam: false }))
      .toThrow(/frameCheckpoint/u)
    expect(() => assertDshCompatibility('system-dedup', { frameCheckpointSeam: false }))
      .toThrow(/vendored base/u)
    // ...and the non-throwing preflight says the same thing, so a diagnostic
    // surface can report it without forcing the failure.
    const supported = framingModeSupported({ frameCheckpointSeam: false })
    expect(supported.systemDedup).toBe(false)
    expect(supported.reason).toContain('silently not deduplicate')
  })

  it('system-dedup WITH the seam passes', () => {
    expect(() => assertDshCompatibility('system-dedup', { frameCheckpointSeam: true })).not.toThrow()
    expect(framingModeSupported({ frameCheckpointSeam: true }).systemDedup).toBe(true)
  })

  it('the only permitted runtime probe is a single prototype typeof, used to REFUSE', () => {
    // The distinction from the forbidden `(Basic as any).frameCheckpoint` form:
    // that shape picks a behavior when the capability is missing and therefore
    // fails OPEN. This module probes once and fails CLOSED. Assert that no
    // other module probes at all.
    const compat = readFileSync(join(import.meta.dirname, '..', 'src', 'compat.ts'), 'utf8')
    expect(compat).toContain("typeof prototype['frameCheckpoint']")
    // The probe exists in exactly one file.
    for (const file of ['engine.ts', 'plugin.ts', 'framing.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8')
      expect(source, `${file} must not probe the seam`).not.toContain("prototype['frameCheckpoint']")
    }
  })
})
