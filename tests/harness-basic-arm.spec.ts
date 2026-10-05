/**
 * The `basic` arm really is Basic — pinned at the source AND at the engine.
 *
 * ## The defect this exists for
 *
 * `bridge-host.ts` built the `basic` arm as `new EpistemicFoldEngine(ctx, common)`
 * where `common` carries no `mode`. The engine defaults to `legacy`
 * (`this.currentModeValue = config.mode ?? 'legacy'`), so the arm ran EF-LEGACY
 * under a `basic` label: EF's frontier invariants applied, EF checkpoints were
 * stamped, and EF bundles were written.
 *
 * The published LHTB table contained its own proof and nobody read it that way —
 * the `archived` column for the `basic` arm read 4, 15, 1, 2 across trials.
 * **Real Basic has no bundle store**, so a non-zero archive count for a "basic"
 * arm is impossible. The label and the behaviour disagreed, and the column that
 * could have caught it was treated as a detail.
 *
 * ## Why this is pinned at two levels
 *
 * `bridge-host.ts` is a script: importing it starts the stdin protocol loop, so
 * a unit test cannot construct its engine. The source assertion therefore pins
 * the CONSTRUCTION (that `mode: 'basic'` is what the arm passes) and the engine
 * assertions pin the SEMANTICS (what `mode: 'basic'` actually does). Together
 * they close the gap the label alone left open.
 *
 * @module tests/harness-basic-arm
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, conversation, SIGNAL } from './harness.ts'

const ROOT = join(import.meta.dirname, '..')
const BRIDGE = join(ROOT, 'eval', 'tau2', 'bridge-host.ts')

describe('the basic arm is constructed as Basic', () => {
  it('bridge-host passes mode:basic for the basic arm', () => {
    const source = readFileSync(BRIDGE, 'utf8')
    // The arm selection must mention `mode: 'basic'` in the branch that handles
    // `engine === 'basic'`. A regex over the source is a blunt instrument, but it
    // is the only reachable check for a file that cannot be imported.
    const basicBranch = /request\.arm\.engine === 'basic'[\s\S]{0,200}?mode: 'basic'/u
    expect(
      basicBranch.test(source),
      "the `basic` arm must pass `mode: 'basic'`; without it the engine defaults to "
      + '`legacy` and the arm measures EF-legacy under a Basic label',
    ).toBe(true)
  })

  it('the arms the harness declares are the ones it can actually build', () => {
    // The Python side names the arms; the bridge branches on `engine` and `mode`.
    // Asserting the pairing here keeps the two halves from drifting apart
    // silently, which is how the label/behaviour split survived.
    const source = readFileSync(BRIDGE, 'utf8')
    expect(source).toContain("request.arm.engine === 'basic'")
    // The tier arms resolve their preset from the declared mode.
    expect(source).toContain('resolvePreset(request.arm.mode)')
  })
})

describe("mode: 'basic' really does stand aside", () => {
  /** An EF engine configured exactly as the fixed `basic` arm configures it. */
  async function basicArmEngine(): Promise<Awaited<ReturnType<typeof createHarness>>['engine']> {
    const { engine } = await createHarness({ text: 'digest' }, {
      contextWindow: 8_000,
      efConfig: { auto: true, thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 2_000, mode: 'basic' },
    })
    return engine
  }

  it('resolves to basic mode, not legacy', async () => {
    const engine = await basicArmEngine()
    const view = engine as unknown as { currentMode: string; basicMode: boolean }
    expect(view.currentMode).toBe('basic')
    expect(view.basicMode).toBe(true)
  })

  it('writes no bundle and stamps no EF marker — the properties real Basic has', async () => {
    // These are the two facts the LHTB table contradicted. Real Basic has no
    // bundle store and no checkpoint vocabulary, so an arm claiming to be Basic
    // must produce zero of both. The `archived` column reading 4/15/1/2 was the
    // signal that it did not.
    const engine = await basicArmEngine()
    const session = conversation(8)
    const agent = {
      session,
      options: { provider: 'test-model', model: 'test-model' },
      runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
    } as never

    await (engine as unknown as {
      compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
    }).compactIfNeeded(agent, 'pressure', SIGNAL)

    expect(engine.bundleWriteCount, 'a Basic arm must not write EF bundles').toBe(0)
    // EF's own fold counters must stay at zero: Basic folds are not EF folds.
    expect(engine.leafFoldCount).toBe(0)
    expect(engine.rootFoldCount).toBe(0)
    expect(engine.emergencyRebaseCount).toBe(0)
    // And no checkpoint body may carry EF's marker.
    const markers = session.surface.nodes.filter((seq) => {
      const message = session.deriveEventMessage(session.eventAt(seq)!)
      return message !== null && JSON.stringify(message.content).includes('EF1')
    })
    expect(markers, 'a Basic arm must not stamp EF checkpoints').toEqual([])
  })

  it('the harness gives Basic a summarization budget a full checkpoint fits in', () => {
    // Found by running a real LHTB trial with the `basic` arm fixed. The arm
    // died with `BridgeError: summarization truncated at the token cap
    // (incomplete checkpoint)` — a FAILED FOLD, not a task failure — after the
    // agent had already made nine substantive shell calls against the task.
    //
    // The cause: the harness passed `maxTokens: 2000`, and that field is the
    // engine's own CHECKPOINT budget (`summarize()` uses `config.maxTokens`),
    // not the agent's reply budget. Basic's full-checkpoint format is far larger
    // than EF's marker-only body, so the summary hit the cap.
    //
    // It was invisible for as long as every arm was EF-legacy, because EF
    // checkpoints fit in 2000. Fixing the `basic` arm is what exposed it.
    const source = readFileSync(BRIDGE, 'utf8')
    const match = /maxTokens: Number\(process\.env\.EF_TAU2_SUMMARY_MAX_TOKENS \?\? ([\d_]+)\)/u.exec(source)
    expect(
      match,
      'the harness must set an explicit, overridable summarization budget',
    ).not.toBeNull()
    const budget = Number(match![1]!.replace(/_/gu, ''))
    expect(
      budget,
      'a budget this small truncates Basic full checkpoints and fails the fold',
    ).toBeGreaterThanOrEqual(8_192)
  })

  it('leaves nothing pending for a consumer it does not have', async () => {
    // A `basic` arm records no rebase intent: it has no rebase concept, and a
    // pending intent would report a leak that no consumer could ever drain.
    const engine = await basicArmEngine()
    const session = conversation(8)
    const agent = {
      session,
      options: { provider: 'test-model', model: 'test-model' },
      runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
    } as never
    await (engine as unknown as {
      compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
    }).compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(engine.pendingRebaseIntentCount).toBe(0)
  })
})
