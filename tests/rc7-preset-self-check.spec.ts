/**
 * RC7-T9/T10: the preset substitution self-check.
 *
 * ## The failure this guards
 *
 * EF reaches DSH's sessions through a bundle patch that restates each preset's
 * whole `config` — the Loader cannot address a row nested in `config.plugins`.
 * That block mirrors the preset rows of the DSH it was generated from, so it is
 * version-specific.
 *
 * When the rows drift, the failure is SILENT. Measured against the installed
 * DSH's own patch algorithm: *a patch whose target row is absent warns and is
 * skipped — boot survives.* A DSH upgrade that renamed `compaction-basic` would
 * therefore leave the user on native Basic while EF's Sidebar and `/context`
 * still reported an EF. That is the RC4-A defect class, arrived at from a
 * different direction, on a machine we cannot see.
 *
 * So the check must exist, and this test must prove it FIRES — a guard that has
 * never been observed firing is indistinguishable from one that cannot.
 *
 * @module tests/rc7-preset-self-check
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { auditPresetSubstitution } from '../src/preset-self-check.ts'
import type { PresetSubstitutionReport } from '../src/preset-self-check.ts'

/**
 * A minimal stand-in for `AgentPresetRegistry`.
 *
 * Only `definitions` is read, and the real registry exposes exactly that as a
 * Map of `{ config: { plugins } }` records. Using the real class would drag the
 * whole preset plane into a unit test for a pure read.
 */
function registryWith(presets: Record<string, readonly unknown[]>): Context {
  const ctx = new Context()
  const definitions = new Map(
    Object.entries(presets).map(([id, plugins]) => [id, { config: { plugins } }]),
  )
  ctx.provide('agentPresets', { definitions } as never)
  return ctx
}

/** The compaction group as DSH declares it, with `backend` as the row name. */
function compactionGroup(backend: string): unknown {
  return {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true, epistemicFold: true },
    config: [
      { id: 'compaction-basic', name: backend },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
    ],
  }
}

describe('RC7-T9: the substitution self-check fires when the patch did not land', () => {
  it('reports LANDED when at least one preset runs EF', () => {
    const ctx = registryWith({
      standard: [compactionGroup('dsh-epistemic-fold')],
      ptc: [compactionGroup('dsh-epistemic-fold')],
      cordis: [compactionGroup('dsh-epistemic-fold')],
      minimal: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }],
    })
    const report = auditPresetSubstitution(ctx)
    expect(report).toBeDefined()
    expect(report!.landed).toBe(true)
    expect(report!.substituted).toBe(3)
    // `minimal` declares no compaction group, so it is not a "miss": EF
    // deliberately leaves that preset exactly as DSH ships it.
    expect(report!.missed).toEqual([])
  })

  it('reports NOT LANDED when no preset names EF — the silent-revert case', () => {
    // This is the state a DSH rename produces: boot survives, every session runs
    // Basic, and nothing says so.
    const ctx = registryWith({
      standard: [compactionGroup('@deepseek-ai/dsh-compaction-basic')],
      ptc: [compactionGroup('@deepseek-ai/dsh-compaction-basic')],
      cordis: [compactionGroup('@deepseek-ai/dsh-compaction-basic')],
      minimal: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }],
    })
    const report = auditPresetSubstitution(ctx)
    expect(report!.landed).toBe(false)
    expect(report!.substituted).toBe(0)
    expect(report!.missed).toEqual(['standard', 'ptc', 'cordis'])
  })

  it('a PARTIAL substitution still counts as landed, but names the misses', () => {
    // A future DSH could restructure one preset but not the others. That is a
    // real state and must not read as total failure — but the untouched presets
    // must be visible, or a silent partial revert would hide behind a green check.
    const ctx = registryWith({
      standard: [compactionGroup('dsh-epistemic-fold')],
      ptc: [compactionGroup('@deepseek-ai/dsh-compaction-basic')],
      minimal: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }],
    })
    const report = auditPresetSubstitution(ctx)
    expect(report!.landed).toBe(true)
    expect(report!.substituted).toBe(1)
    expect(report!.missed).toEqual(['ptc'])
  })

  it('returns undefined where the check does not apply (no preset plane)', () => {
    // A headless or compaction-only deployment has no presets to substitute
    // into. Reporting a failure there would be a false alarm.
    const ctx = new Context()
    expect(auditPresetSubstitution(ctx)).toBeUndefined()
  })
})

describe('RC7-T10: the self-check reads the SAME facts the loader composed', () => {
  it('detects the backend by the row name the loader resolves', () => {
    // The check must not invent its own notion of "EF is installed". It reads
    // the `name:` of the `compaction-basic` row, which is exactly what the
    // Loader imports — so a row that names EF but would fail to import still
    // counts as substituted, and the import failure surfaces on its own.
    const ctx = registryWith({ standard: [compactionGroup('dsh-epistemic-fold')] })
    const report = auditPresetSubstitution(ctx) as PresetSubstitutionReport
    expect(report.rows).toEqual([{ id: 'standard', usesEpistemicFold: true, hasCompactionGroup: true }])
  })

  it('a group without a compaction-basic row is a MISS, not a pass', () => {
    // If a future DSH renames the row, the group exists but no backend is found.
    // Treating "no backend row" as satisfied would make the check blind to
    // exactly the drift it exists to catch.
    const ctx = registryWith({
      standard: [{ id: 'compaction', name: 'cordis:group', group: true, config: [{ id: 'command-compact' }] }],
    })
    const report = auditPresetSubstitution(ctx)!
    expect(report.landed).toBe(false)
    expect(report.missed).toEqual(['standard'])
  })
})

describe('RC7-T9b: the doctor is mounted OUTSIDE the preset plane', () => {
  it('its row lives outside the generated block, so a missed substitution still mounts it', () => {
    // THE STRUCTURAL PROPERTY. The first version of this check lived inside
    // `EpistemicFoldPlugin` and could never fire: EF is mounted BY the preset
    // substitution — a row inside each preset's compaction group — so when the
    // substitution misses, EF never mounts and a check inside it never runs.
    // That was found by booting a deliberately broken install and observing that
    // the check's log line never appeared.
    //
    // So the doctor's row must sit OUTSIDE the generated region: the generator
    // rewrites everything between the markers, and a row inside them would be
    // erased exactly when it is needed.
    const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    const begin = patch.indexOf('# >>> epistemic-fold preset overrides')
    const end = patch.indexOf('# <<< epistemic-fold preset overrides')
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)

    const doctorAt = patch.indexOf('epistemic-fold-doctor')
    expect(doctorAt, 'the doctor row must exist').toBeGreaterThan(-1)
    expect(
      doctorAt < begin || doctorAt > end,
      'the doctor row must be OUTSIDE the generated block, or a regeneration would delete it',
    ).toBe(true)

    // ...and it must be a top-level row, not nested inside a preset's plugins.
    const beforeBlock = patch.slice(0, begin)
    expect(beforeBlock).toContain('epistemic-fold-doctor')
    expect(beforeBlock).toMatch(/^ {4}- id: epistemic-fold-doctor$/mu)
  })

  it('the doctor is observation-only: it provides no service', () => {
    // The RC4-A constraint. A doctor that provided a service or registered a
    // projection would be a mounted EF surface that reports while Basic folds —
    // the exact defect the substitution design exists to avoid.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'doctor.ts'), 'utf8')
    expect(source, 'the doctor must not provide a service').not.toMatch(/\bprovide\s*\(/u)
    expect(source, 'the doctor must not register a projection').not.toMatch(/sessionProjections/u)
    expect(source, 'the doctor must not register tools').not.toMatch(/registerRecallTools/u)
    // It must not rewrite the loader tree either: measured, that is a race
    // against boot ordering and can rewrite the user's cordis.yml.
    expect(source, 'the doctor must not mutate the loader tree').not.toMatch(/\.update\s*\(/u)
  })
})
