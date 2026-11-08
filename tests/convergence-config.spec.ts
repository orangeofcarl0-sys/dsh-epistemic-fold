/**
 * EF-C0 WP2 — configuration truth.
 *
 * Two kinds of assertion:
 *
 *  1. RESOLUTION: what `resolveEfConfig` and `describeEffectiveConfig` produce.
 *     These are pure functions and need no host.
 *  2. RUNTIME: how many auxiliary calls a fold actually makes, observed through
 *     the real engine and a scripted adapter. A configuration that DECLARES a
 *     writer but never calls it (or calls it when told not to) is the defect
 *     this half exists to catch.
 *
 * The scripted adapter is the boundary. Validation, planning, journal, commit
 * and replay all run for real.
 *
 * @module tests/convergence-config
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { resolveEfConfig } from '../src/config/policy.ts'
import { describeEffectiveConfig } from '../src/config/effective-config.ts'
import { TIERS, presetOverrides } from '../src/config/preset.ts'
import type { EpistemicFoldConfig } from '../src/config/policy.ts'
import { createHarness, conversation, foldAgent, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'

const WRITER_REPLY = [
  '<handoff>', 'A terse handoff.', '</handoff>',
  '<deltas>', '{"deltas":[]}', '</deltas>',
].join('\n')

/** The writer call is the one whose final user message is the writer instruction. */
function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

/** The visible rationale call is the one whose instruction names the RATIONALE writer. */
function isRationaleCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are acting as the RATIONALE writer'))
}

interface FoldResult {
  readonly h: Harness
  readonly root: string
  readonly calls: readonly GenerateOptions[]
}

/**
 * Fold the whole open span once, through the production transaction, and
 * report the compaction-purpose calls the adapter saw.
 */
async function foldOnce(
  efConfig: EpistemicFoldConfig,
  options: { readonly plugin?: boolean; readonly tools?: boolean; readonly projection?: boolean } = {},
): Promise<FoldResult> {
  const root = await makeTemp('ef-c0-config-')
  const h = await createHarness(
    { textFor: call => (isWriterCall(call) ? WRITER_REPLY : 'digest') },
    {
      projection: options.projection ?? true,
      // Every product tier selects `system-dedup` framing, which REFUSES to run
      // without a system prompt. Mounting it is what makes the tier's real
      // configuration runnable; omitting it would test a different config.
      systemPrompt: true,
      ...(options.plugin === true ? { plugin: true } : {}),
      ...(options.tools === true ? { tools: true } : {}),
      efConfig: {
        bundleRoot: join(root, 'bundles'),
        semanticRoot: join(root, 'semantic'),
        ...efConfig,
      },
    },
  )
  const session = conversation(2)
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return { h, root, calls: h.control.calls.map(call => call.options) }
}

describe('EF-C0 config: the three tiers as the resolver actually produces them', () => {
  it('every tier carries the rationale face; they differ in budget, not in whether they ask', () => {
    // The historical architecture document said economy/balanced were
    // `semantic none`. The resolver says otherwise, and the resolver is the
    // authority. This test pins the current truth so the document cannot drift
    // back without a failure.
    for (const name of ['economy', 'balanced', 'quality'] as const) {
      const resolved = resolveEfConfig({ mode: name })
      expect(resolved.semanticMode, `${name} semanticMode`).toBe('rationale')
      expect(resolved.semanticContinuity, `${name} continuity default`).toBe('off')
      expect(resolved.framingMode, `${name} framing`).toBe('system-dedup')
      expect(resolved.leafAdmission, `${name} admission`).toBe('economic')
      expect(resolved.rootPolicy.mode, `${name} root policy`).toBe('economics')
    }
    expect(TIERS.economy.values.rationaleHintTokens).toBe(400)
    expect(TIERS.balanced.values.rationaleHintTokens).toBe(800)
    expect(TIERS.quality.values.rationaleHintTokens).toBe(1600)
    expect(TIERS.economy.values.retainRatio).toBeUndefined()
    expect(TIERS.balanced.values.retainRatio).toBe(0.24)
    expect(TIERS.quality.values.retainRatio).toBe(0.24)
  })

  it('an explicit key beats the tier, and the reporter agrees with the resolver', () => {
    const resolved = resolveEfConfig({ mode: 'economy', rationaleHintTokens: 1200 })
    expect(resolved.rationaleHintTokens).toBe(1200)

    const described = describeEffectiveConfig({ mode: 'economy', rationaleHintTokens: 1200 })
    const hint = described.settings.find(setting => setting.key === 'rationaleHintTokens')
    expect(hint).toEqual({ key: 'rationaleHintTokens', value: 1200, origin: 'explicit' })
    expect(described.overrides).toContainEqual({ key: 'rationaleHintTokens', preset: 400, explicit: 1200 })
  })

  it('retainRatio is not an override when the tier never owned it', () => {
    // `economy` leaves retention to the engine, so setting it is a choice the
    // tier never contradicted — not an override. `presetOverrides` says so.
    const resolved = resolveEfConfig({ mode: 'economy', retainRatio: 0.3 })
    expect(resolved.retainRatio).toBe(0.3)
    expect(presetOverrides('economy', { retainRatio: 0.3 })).toEqual([])
  })

  it('the zero-LLM profile is expressible and explicit', () => {
    const resolved = resolveEfConfig({
      mode: 'quality',
      semanticMode: 'none',
      semanticContinuity: 'off',
    })
    expect(resolved.semanticMode).toBe('none')
    expect(resolved.semanticContinuity).toBe('off')
  })

  it('semantic continuity cannot run under semanticMode none', () => {
    // The writer shares the rationale call. Allowing active continuity under
    // the zero-LLM profile would upgrade that profile behind the deployment's
    // back, so resolution refuses it.
    for (const semanticContinuity of ['shadow', 'active'] as const) {
      expect(() => resolveEfConfig({ semanticMode: 'none', semanticContinuity }))
        .toThrow(/requires semanticMode "rationale"/u)
    }
  })

  it('an unknown mode is an error, not a silent legacy fallthrough', () => {
    expect(() => resolveEfConfig({ mode: 'econnomy' as never }))
      .toThrow(/unknown mode/u)
  })
})

describe('EF-C0 config: auxiliary calls on the real fold path', () => {
  it('semanticMode none + continuity off makes ZERO auxiliary calls', async () => {
    const { calls, h } = await foldOnce({ mode: 'economy', semanticMode: 'none', semanticContinuity: 'off' })
    expect(calls, 'the zero-LLM profile must not call the model for a checkpoint').toHaveLength(0)
    expect(h.engine.rationaleAttempts).toBe(0)
    expect(h.engine.semanticWriterStats.calls).toBe(0)
    expect(h.engine.lastSemanticPacket).toBeUndefined()
  })

  it('semanticMode rationale + continuity off makes ONE rationale call', async () => {
    const { calls, h } = await foldOnce({ mode: 'economy', semanticMode: 'rationale', semanticContinuity: 'off' })
    expect(calls).toHaveLength(1)
    expect(isRationaleCall(calls[0]!)).toBe(true)
    expect(h.engine.rationaleAttempts).toBe(1)
    expect(h.engine.semanticWriterStats.calls).toBe(0)
    expect(h.engine.lastSemanticPacket).toBeUndefined()
  })

  it('shadow makes the visible rationale call PLUS one diagnostic writer call', async () => {
    const { calls, h } = await foldOnce({ mode: 'economy', semanticContinuity: 'shadow' })
    expect(calls).toHaveLength(2)
    expect(calls.filter(isRationaleCall)).toHaveLength(1)
    expect(calls.filter(isWriterCall)).toHaveLength(1)
    expect(h.engine.rationaleAttempts).toBe(1)
    expect(h.engine.semanticWriterStats.calls).toBe(1)

    // Shadow stages an observation, never a commit.
    expect(h.engine.lastSemanticPacket?.mode).toBe('shadow')
    expect(h.engine.lastSemanticPacket?.ops).toEqual([])
    expect(h.engine.lastSemanticReceipt, 'shadow must write no receipt').toBeUndefined()
    expect(h.engine.semanticDiagnostics.committed).toBe(0)
  })

  it('active makes ONE combined writer call, not a rationale plus a writer', async () => {
    const { calls, h } = await foldOnce({ mode: 'economy', semanticContinuity: 'active' })
    expect(calls).toHaveLength(1)
    expect(isWriterCall(calls[0]!)).toBe(true)
    expect(h.engine.rationaleAttempts).toBe(0)
    expect(h.engine.semanticWriterStats.calls).toBe(1)
    expect(h.engine.lastSemanticPacket?.mode).toBe('active')
  })

  it('rationale is CONFIGURED but not EXECUTED when no state projection is mounted', async () => {
    // This is the "configured vs actually executed" distinction. With no
    // projection there is no machine state to render, so the engine takes
    // Basic's full-checkpoint summary path. The rationale call does not happen
    // even though `semanticMode` says `rationale`.
    const { calls, h } = await foldOnce({ mode: 'economy' }, { projection: false })
    expect(calls).toHaveLength(1)
    expect(isRationaleCall(calls[0]!), 'no rationale call without a projection').toBe(false)
    expect(isWriterCall(calls[0]!)).toBe(false)
    expect(h.engine.rationaleAttempts).toBe(0)
    expect(h.engine.semanticWriterStats.calls).toBe(0)
  })
})

describe('EF-C0 config: basic mode mounts nothing and calls nothing semantic', () => {
  it('no EF surface, no EF tools, and the fold is Basic summary only', async () => {
    const { h } = await foldOnce(
      { mode: 'basic' },
      { plugin: true, tools: true },
    )
    expect(h.plugin, 'this arm must mount the plugin').toBeDefined()
    expect(h.engine.basicMode).toBe(true)
    expect(h.plugin!.anchors).toBeUndefined()
    expect(h.ctx.get('epistemicFold')).toBeUndefined()

    const toolNames = h.ctx.tools.schemas().map(schema => schema.name)
    expect(toolNames).not.toContain('context_search')
    expect(toolNames).not.toContain('context_recall')

    // The fold landed through Basic, and no semantic packet exists.
    expect(h.engine.publishedBundle, 'Basic mode must not publish an EF bundle').toBeUndefined()
    expect(h.engine.semanticWriterStats.calls).toBe(0)
    expect(h.engine.lastSemanticPacket).toBeUndefined()
  })

  it('basic + semanticContinuity active still performs no semantic call and writes no journal', async () => {
    // This combination resolves (both keys are individually valid) but the
    // engine delegates to Basic, so the semantic layer must be inert. The
    // journal directory is the observable: it is created only by a write.
    const { h, root, calls } = await foldOnce(
      { mode: 'basic', semanticContinuity: 'active' },
      { plugin: true, tools: true },
    )
    expect(h.engine.basicMode).toBe(true)
    expect(h.engine.semanticWriterStats.calls).toBe(0)
    expect(h.engine.lastSemanticPacket).toBeUndefined()
    expect(calls.every(call => !isWriterCall(call)), 'no writer call under basic').toBe(true)
    expect(existsSync(join(root, 'semantic')), 'basic must not create a semantic journal').toBe(false)
  })
})
