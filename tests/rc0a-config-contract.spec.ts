/**
 * RC0-A: the configuration contract.
 *
 * R4 reached "research-eligible for a default flip" while three places in the
 * configuration surface could still silently do something other than what was
 * asked. Each is a release blocker rather than a research concern, because each
 * one lets a deployment believe it is running economy mode while it is not:
 *
 * 1. `mode: 'econnomy'` (a typo) fell through to engine defaults, running
 *    LEGACY while the YAML said economy.
 * 2. `mode: economy` with no `ctx.systemPrompt` silently ran per-checkpoint
 *    framing, so the deployment did not get the measured RBCR it requested.
 * 3. `REQUIRED_DSH_RANGE = '>=0.1.7-rc.2'` named a version that provably does
 *    NOT carry the seam — the pinned vanilla build at 477b4f4 is 0.1.7-rc.2.
 *
 * A named mode has to mean one determinate behavior, so all three now fail
 * loud. This suite pins that, and pins that `legacy` and the default path stay
 * permissive.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_SEAM_PROVENANCE, REQUIRED_DSH_RANGE, assertDshCompatibility } from '../src/compat.ts'
import { framingModeFor } from '../src/framing.ts'
import { describeEffectiveConfig, effectiveConfigToText } from '../src/effective-config.ts'
import { resolveEfConfig } from '../src/policy.ts'
import { resolvePreset } from '../src/preset.ts'
import { createHarness } from './harness.ts'
import { allWorkloads } from '../eval/workloads/index.ts'

describe('RC0-A: an unknown mode is an error, never a silent legacy run', () => {
  it('rejects a typo instead of running the wrong policy', () => {
    // The exact failure mode: the deployment asks for economy, gets legacy,
    // and nothing anywhere says so.
    expect(() => resolveEfConfig({ mode: 'econnomy' as never })).toThrow(/unknown mode/u)
    expect(() => resolveEfConfig({ mode: 'Economy' as never })).toThrow(/unknown mode/u)
    expect(() => resolveEfConfig({ mode: '' as never })).toThrow(/unknown mode/u)
    // The message lists the valid names, so the remedy is in the error.
    expect(() => resolveEfConfig({ mode: 'nope' as never })).toThrow(/"legacy".*"economy"/u)
  })

  it('still accepts every REAL mode, and the default', () => {
    expect(resolveEfConfig({}).leafAdmission).toBe('legacy')
    expect(resolveEfConfig({ mode: 'legacy' }).leafAdmission).toBe('legacy')
    expect(resolveEfConfig({ mode: 'economy' }).leafAdmission).toBe('economic')
  })

  it('the guard is on the MODE key only, so other config is unaffected', () => {
    // A config with no `mode` at all must not trip the guard.
    expect(() => resolveEfConfig({ leafAdmission: 'economic' })).not.toThrow()
    expect(() => resolveEfConfig({ framingMode: 'system-dedup' })).not.toThrow()
  })
})

describe('RC0-A: explicit system-dedup with nowhere to put the semantics FAILS', () => {
  it('throws instead of falling back to per-checkpoint framing', () => {
    // R3 fell back with a warning. That meant a deployment asking for the
    // deduplicated framing silently did not get it — and therefore did not get
    // the economy result — while believing otherwise.
    expect(() => framingModeFor('system-dedup', false)).toThrow(/ctx\.systemPrompt/u)
    expect(() => framingModeFor('system-dedup', false)).toThrow(/Refusing to start/u)
    // The remedy is named.
    expect(() => framingModeFor('system-dedup', false)).toThrow(/dsh-system-prompt/u)
  })

  it('legacy needs nothing, so the DEFAULT path stays permissive', () => {
    // No fallback was ever needed for the default: the engine default IS
    // legacy. Removing the fallback therefore costs a default deployment
    // nothing, which is why it is safe to make an explicit request strict.
    expect(framingModeFor('legacy', false)).toEqual({ mode: 'legacy' })
    expect(framingModeFor('legacy', true)).toEqual({ mode: 'legacy' })
    expect(framingModeFor('system-dedup', true)).toEqual({ mode: 'system-dedup' })
  })

  it('the engine mount fails loudly when economy is requested without a system prompt', async () => {
    // End to end: not just the pure function. Mounting `mode: economy` into a
    // context with no SystemPrompt must not silently produce a legacy run.
    await expect(
      createHarness({ text: 'digest' }, {
        contextWindow: 16_000,
        plugin: true,
        // deliberately NO systemPrompt
        efConfig: { mode: 'economy' },
      }),
    ).rejects.toThrow(/system-dedup|systemPrompt/u)
  }, 120_000)

  it('and SUCCEEDS when the system prompt is mounted', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 16_000, plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy' },
    })
    expect(harness.engine.efConfig.framingMode).toBe('system-dedup')
  }, 120_000)

  it('no silent-fallback branch survives anywhere in the framing path', () => {
    // A structural assertion: the `fallback` field is gone from the return
    // type, so a future edit cannot quietly reintroduce the downgrade.
    const framing = readFileSync(join(import.meta.dirname, '..', 'src', 'framing.ts'), 'utf8')
    expect(framing).not.toContain('fallback?:')
    expect(framing).not.toContain('falling back')
    for (const file of ['engine.ts', 'plugin.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8')
      expect(source, `${file} must not handle a framing fallback`).not.toContain('resolved.fallback')
    }
  })
})

describe('RC0-A: the DSH contract names a capability, not a version that lacks it', () => {
  it('does not claim a semver range for an unreleased seam', () => {
    // The audit finding: `>=0.1.7-rc.2` is the version of the pinned vanilla
    // build at 477b4f4, which does NOT have the seam. A range would tell a
    // user their build "should" support it.
    //
    // RC7 moved the seam into EF's own vendored base class, so there is no
    // host capability left to name a version for. What must survive is the
    // reason the old text was wrong: no version claim at all.
    expect(REQUIRED_DSH_RANGE).toBeUndefined()
    expect(DSH_SEAM_PROVENANCE).toContain('src/basic/')
    expect(DSH_SEAM_PROVENANCE).toMatch(/vendored/u)
  })

  it('the failure message names the capability and the remedy, not a version', () => {
    let message = ''
    try {
      assertDshCompatibility('system-dedup', { frameCheckpointSeam: false })
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('frameCheckpoint')
    expect(message).toContain('system-dedup')
    // It must NOT promise that a version satisfies the requirement, and it must
    // not send the user to patch their DSH — RC7 removed that requirement.
    expect(message).not.toMatch(/>=\s*0\.1\.7/u)
    expect(message).not.toContain('apply-framing-seam')
  })
})

describe('RC0-A: the effective configuration is reportable', () => {
  it('shows where every preset-owned setting came from', () => {
    const effective = describeEffectiveConfig({ mode: 'economy' }, { frameCheckpointSeam: true })
    expect(effective.mode).toBe('economy')
    const origins = Object.fromEntries(effective.settings.map(setting => [setting.key, setting.origin]))
    expect(origins['leafAdmission']).toBe('preset')
    expect(origins['framingMode']).toBe('preset')
    expect(effective.blockers).toEqual([])
  })

  it('marks an explicit override as explicit, not as the preset', () => {
    const effective = describeEffectiveConfig(
      { mode: 'economy', semanticMode: 'rationale' },
      { frameCheckpointSeam: true },
    )
    const semantic = effective.settings.find(setting => setting.key === 'semanticMode')!
    expect(semantic.origin).toBe('explicit')
    expect(semantic.value).toBe('rationale')
    expect(effective.overrides).toEqual([
      { key: 'semanticMode', preset: 'none', explicit: 'rationale' },
    ])
  })

  it('reports a blocker WITHOUT throwing, so a preflight can surface it', () => {
    // The engine still refuses to start; this surface explains why first.
    const effective = describeEffectiveConfig({ mode: 'economy' }, { frameCheckpointSeam: false })
    expect(effective.blockers.length).toBeGreaterThan(0)
    expect(effective.blockers[0]).toContain('frameCheckpoint')
    expect(effective.systemDedupSupported).toBe(false)
  })

  it('reports an unknown mode as a blocker rather than a silent legacy', () => {
    const effective = describeEffectiveConfig({ mode: 'econnomy' as never })
    expect(effective.blockers.some(blocker => blocker.includes('unknown mode'))).toBe(true)
  })

  it('renders to text with the blockers last and unmistakable', () => {
    const text = effectiveConfigToText(describeEffectiveConfig({ mode: 'economy' }, { frameCheckpointSeam: false }))
    expect(text).toContain('mode: economy')
    expect(text).toContain('leafAdmission = "economic"')
    expect(text).toContain('[preset]')
    expect(text).toContain('BLOCKERS')
    // The blocker section is what a human reads when the mount fails.
    expect(text.indexOf('BLOCKERS')).toBeGreaterThan(text.indexOf('leafAdmission'))
  })

  it('a default legacy deployment reports no blockers', () => {
    const effective = describeEffectiveConfig({}, { frameCheckpointSeam: false })
    expect(effective.blockers).toEqual([])
    expect(effective.mode).toBe('legacy')
    expect(effective.settings.every(setting => setting.origin === 'engine-default')).toBe(true)
  })
})

describe('RC0-A: the preset still expands identically to writing the keys', () => {
  it('economy === the four explicit keys', () => {
    expect(resolvePreset('economy')).toEqual({
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      semanticMode: 'none',
      framingMode: 'system-dedup',
    })
  })

  it('a full fold still works under mode: economy', async () => {
    // The contract changes must not have broken the actual runtime path.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 16_000, plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy' },
    })
    const session = allWorkloads()[0]!.createSession()
    expect(harness.engine.efConfig.leafAdmission).toBe('economic')
    expect(harness.engine.efConfig.rootPolicy.mode).toBe('economics')
    expect(harness.engine.efConfig.semanticMode).toBe('none')
    expect(session.surface.nodes.length).toBeGreaterThan(0)
  }, 120_000)
})
