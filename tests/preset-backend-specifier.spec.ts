/**
 * The generated preset must name a module that can actually BE the backend.
 *
 * ## The defect this exists to catch
 *
 * RC7 moved the bare package name to the doctor (`src/entry.ts`) so the client
 * roster could find the package's browser half — correct, and necessary. But the
 * preset generator kept emitting `name: dsh-epistemic-fold` for the row that
 * replaces `compaction-basic`.
 *
 * The bare name resolves to the DOCTOR, which provides no service at all. So
 * every preset's compaction group mounted a module that could not register
 * `ctx.compaction`; `command-compact` — which declares `inject: ['commands',
 * 'compaction']` — waited on that service forever, the preset audit failed the
 * mount, and **every session on the profile failed to resume**:
 *
 *     command-compact (@deepseek-ai/dsh-command-compact): waiting for compaction
 *
 * ## Why the existing tests did not catch it
 *
 * Three separate checks all passed while the profile was unusable:
 *
 *  - `rc7-inplace-drift` asserted the row named `dsh-epistemic-fold` — which is
 *    exactly what the bug emitted. The test protected it.
 *  - `dsh --profile <name> --dump-config` prints the COMPOSED CONFIG TREE. The
 *    config was correct; the module behind it was not. It cannot see activation.
 *  - The UI's preset chip renders the PRESET's name (`standard`, `ptc`), not the
 *    module that mounted. It looks identical either way.
 *
 * Every one of those checks compares *names*. The property that matters is
 * behavioural: does the named module, when loaded, provide what the preset's
 * siblings inject? This suite asserts that, by actually importing the specifier
 * the patch names and inspecting what it offers.
 *
 * @module tests/preset-backend-specifier
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = join(import.meta.dirname, '..')
const PATCH = join(ROOT, 'cordis.patch.yml')

/** The specifier the patch names for the row that replaces `compaction-basic`. */
function backendSpecifier(): string {
  const lines = readFileSync(PATCH, 'utf8').split(/\r?\n/u)
  const index = lines.findIndex(line => line.trim() === '- id: compaction-basic')
  if (index < 0) throw new Error('no compaction-basic row in cordis.patch.yml')
  for (const line of lines.slice(index + 1, index + 6)) {
    const match = /^\s*name:\s*(\S+)\s*$/u.exec(line)
    if (match !== null) return match[1]!
  }
  throw new Error('the compaction-basic row has no name')
}

/** Every specifier the patch names, so the doctor row can be checked too. */
function allSpecifiers(): readonly string[] {
  return readFileSync(PATCH, 'utf8')
    .split(/\r?\n/u)
    .map(line => /^\s*name:\s*(\S+)\s*$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
}

const require_ = createRequire(join(ROOT, 'package.json'))

describe('the preset backend names a module that can be the backend', () => {
  it('names the plugin SUBPATH, not the bare package name', () => {
    // The bare name is reserved for the doctor. Naming it here is the defect.
    expect(backendSpecifier()).toBe('dsh-epistemic-fold/plugin')
  })

  it('the named module resolves from a real install', () => {
    // Resolution, not just a string compare: the specifier must be importable
    // through the package's own exports map, which is how the loader reads it.
    expect(() => require_.resolve(backendSpecifier())).not.toThrow()
  })

  it('the named module is the PLUGIN, and the bare name is the DOCTOR', async () => {
    const plugin = await import(backendSpecifier())
    const bare = await import('dsh-epistemic-fold')

    // The plugin exports the class that constructs the engine.
    const PluginClass = (plugin.default ?? plugin.EpistemicFoldPlugin) as {
      readonly name?: string
      readonly inject?: readonly string[]
    }
    expect(typeof PluginClass, 'the plugin subpath must export a class').toBe('function')

    // The plugin needs the services the engine needs. `sessions`, `llm` and
    // `tokenMeter` come from `EpistemicFoldEngine.inject`; a module that cannot
    // see them cannot fold.
    const inject = [...(PluginClass.inject ?? [])]
    for (const service of ['llm', 'tokenMeter', 'sessions']) {
      expect(inject, `the backend must inject ${service}`).toContain(service)
    }

    // The doctor is the opposite: observation only, and it declares no engine
    // services. This is what made it unusable as a backend.
    const doctorName = (bare as { readonly name?: string }).name
    expect(doctorName, 'the bare name must still be the doctor').toBe('epistemic-fold-doctor')
    expect(PluginClass.name, 'the plugin must not be the doctor').not.toBe(doctorName)
  })

  it('keeps exactly one bare-name row, so the client roster still finds the package', () => {
    // `exactPackageSpecifier` in dsh-client-modules rejects any specifier
    // containing '/'. The roster scans host loader rows for the bare name to
    // locate the package's browser half, so removing it would silently drop the
    // Sidebar panel — the RC7 defect in `src/entry.ts`. One row must keep it.
    const specifiers = allSpecifiers()
    const bare = specifiers.filter(s => s === 'dsh-epistemic-fold')
    expect(bare.length, 'exactly one row must carry the bare name').toBe(1)

    // And it must be the doctor, not a preset backend.
    const lines = readFileSync(PATCH, 'utf8').split(/\r?\n/u)
    const index = lines.findIndex(line => line.trim() === 'name: dsh-epistemic-fold')
    const owner = lines[index - 1]?.trim()
    expect(owner, 'the bare name belongs to the doctor row').toBe('- id: epistemic-fold-doctor')
  })

  it('every preset targets the same backend specifier', () => {
    // Three presets, one backend. A patch where one preset names the doctor and
    // another names the plugin is worse than either, because the breakage would
    // look preset-specific.
    const lines = readFileSync(PATCH, 'utf8').split(/\r?\n/u)
    const backends = lines
      .map((line, index) => (line.trim() === '- id: compaction-basic' ? index : -1))
      .filter(index => index >= 0)
      .map(index => {
        for (const line of lines.slice(index + 1, index + 6)) {
          const match = /^\s*name:\s*(\S+)\s*$/u.exec(line)
          if (match !== null) return match[1]!
        }
        return '<none>'
      })
    expect(backends.length, 'the patch must substitute every shipped preset').toBe(3)
    expect(new Set(backends).size, `all backends must agree, got ${backends.join(', ')}`).toBe(1)
    expect(backends[0]).toBe('dsh-epistemic-fold/plugin')
  })
})
