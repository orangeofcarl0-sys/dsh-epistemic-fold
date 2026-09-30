/**
 * RC5: EF's presets must stay a MIRROR of DSH's, and say so when they stop being one.
 *
 * ## Why this test exists
 *
 * A preset declares its session's entire plugin list, so EF's presets carry the
 * same non-compaction rows DSH's own presets do. Those rows are GENERATED from
 * the installed DSH build (`scripts/generate-presets.mjs`) rather than hand-copied
 * — but "generated" only means the copy was correct on the day it ran. When DSH
 * adds a tool row to `standard`, EF's checked-in presets keep the old list, and
 * an EF session silently becomes a leaner agent than a standard one.
 *
 * That is the failure this file prevents, and it is the SAME failure the override
 * approach was rejected for: a copy that drifts. The difference is that here the
 * drift is DETECTED — the test fails loudly, naming what diverged, so the remedy
 * is one regeneration command rather than an investigation.
 *
 * ## How it parses
 *
 * With a small structural reader rather than a YAML library. The repository has
 * no YAML dependency, and adding one to check two files would be a dependency
 * bought for a test. The reader understands exactly what a preset patch is — an
 * `insert:` list of rows, each with `id`/`name`/`config`, plus nested groups — and
 * nothing else, so it cannot silently accept a shape the loader would reject.
 *
 * ## When it cannot run
 *
 * The reference lives in an INSTALLED DSH, which a CI machine may not have. The
 * test SKIPS then, and prints that the mirror was NOT verified — an unverifiable
 * mirror must not report as a verified one.
 *
 * @module tests/rc5-preset-drift
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TIER_MODE_NAMES } from '../src/preset.ts'

const ROOT = join(import.meta.dirname, '..')

/** The reference preset path, or `undefined` when no DSH is installed. */
function referencePath(): string | undefined {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const base = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  const candidates = [
    join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'),
    join(base, 'dsh-web-app', 'presets', 'standard.patch.yml'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * The YAML reader, loaded from the DSH installation.
 *
 * The repository deliberately has no YAML dependency, and adding one to compare
 * two files would be a dependency bought for a test. DSH already ships
 * `js-yaml`, and this test only runs on a machine that has DSH installed (the
 * reference preset lives there), so the reader is resolved from that install.
 *
 * The loader's `!!js` tag carries an expression it evaluates at boot; this test
 * compares structure, so the tag is read as its raw scalar.
 */
interface YamlReader {
  load(text: string, options: { schema: unknown }): unknown
}

function yamlReader(): YamlReader {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const requireFrom = createRequire(join(home, 'profiles', 'package.json'))
  const yaml = requireFrom('js-yaml') as {
    Type: new (tag: string, options: { kind: string; construct: (data: string) => string }) => unknown
    DEFAULT_SCHEMA: { extend(types: unknown[]): unknown }
    load(text: string, options: { schema: unknown }): unknown
  }
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data: string) => data,
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  return { load: (text, _options) => yaml.load(text, { schema }) }
}

/** One preset plugin row, as the loader's schema would parse it. */
interface Row {
  readonly id?: string
  readonly name?: string
  readonly isolate?: Record<string, boolean>
  readonly config?: unknown
}

/** The `plugins` list of the preset row with this id, from a patch file. */
function pluginsOf(path: string, presetId: string): Row[] {
  const reader = yamlReader()
  const parsed = reader.load(readFileSync(path, 'utf8'), { schema: undefined }) as
    | { insert?: Row[] }[]
    | undefined
  if (!Array.isArray(parsed)) throw new Error(`${path} did not parse to a patch list`)
  for (const entry of parsed) {
    for (const row of entry.insert ?? []) {
      if (row.id !== presetId) continue
      const plugins = (row.config as { plugins?: Row[] } | undefined)?.plugins
      if (plugins === undefined) throw new Error(`${presetId} in ${path} has no plugins list`)
      return plugins
    }
  }
  throw new Error(`${path} has no preset row ${presetId}`)
}

/** The inner rows of a group row. */
function innerRows(row: Row): Row[] {
  const config = row.config
  return Array.isArray(config) ? config as Row[] : []
}

describe('RC5: EF presets mirror DSH, and detect when they stop', () => {
  const reference = referencePath()

  it.skipIf(reference === undefined)('carries the same non-compaction rows as the installed reference', () => {
    const referenceRows = pluginsOf(reference!, 'preset-standard')
    expect(referenceRows.length).toBeGreaterThan(0)

    for (const tier of TIER_MODE_NAMES) {
      const file = join(ROOT, 'presets', `ef-${tier}.patch.yml`)
      const efRows = pluginsOf(file, `preset-ef-${tier}`)

      // The compaction group is the ONE row allowed to differ.
      const referenceOthers = referenceRows.filter(row => row.id !== 'compaction')
      const efOthers = efRows.filter(row => row.id !== 'compaction')

      expect(
        efOthers.map(row => row.id),
        `ef-${tier} must carry the same non-compaction rows, in the same order, as DSH's standard. `
        + 'Regenerate with `node scripts/generate-presets.mjs` after a DSH upgrade.',
      ).toEqual(referenceOthers.map(row => row.id))

      // And each carried row must be the same row, not merely the same id.
      for (let index = 0; index < referenceOthers.length; index += 1) {
        expect(
          efOthers[index],
          `ef-${tier} row ${String(referenceOthers[index]?.id)} must match the reference exactly`,
        ).toEqual(referenceOthers[index])
      }
    }
  })

  it.skipIf(reference === undefined)('differs in the compaction group ONLY by backend and realm', () => {
    const referenceGroup = pluginsOf(reference!, 'preset-standard').find(row => row.id === 'compaction')
    expect(referenceGroup).toBeDefined()

    for (const tier of TIER_MODE_NAMES) {
      const file = join(ROOT, 'presets', `ef-${tier}.patch.yml`)
      const efGroup = pluginsOf(file, `preset-ef-${tier}`).find(row => row.id === 'compaction')
      expect(efGroup, `ef-${tier} must keep the compaction group`).toBeDefined()

      // Every realm the reference declared is kept...
      for (const realm of Object.keys(referenceGroup!.isolate ?? {})) {
        expect(efGroup!.isolate?.[realm], `ef-${tier} must keep the ${realm} realm`).toBe(true)
      }
      // ...and `epistemicFold` is added, because EF provides that service and an
      // unisolated one makes the SECOND preset to mount collide on it.
      expect(
        efGroup!.isolate?.['epistemicFold'],
        `ef-${tier} must isolate epistemicFold, or the second preset to mount collides on it`,
      ).toBe(true)

      const inner = innerRows(efGroup!)
      const efRow = inner.find(row => row.id === 'epistemic-fold')
      expect(efRow, `ef-${tier} must mount EF in the compaction group`).toBeDefined()
      expect(efRow!.name).toBe('dsh-epistemic-fold')
      expect(
        inner.some(row => row.id === 'compaction-basic'),
        `ef-${tier} must NOT also carry compaction-basic`,
      ).toBe(false)

      // The backend-independent rows are carried unchanged.
      const referenceOthers = innerRows(referenceGroup!).filter(row => row.id !== 'compaction-basic')
      const efOthers = inner.filter(row => row.id !== 'epistemic-fold')
      expect(
        efOthers.map(row => row.id),
        `ef-${tier} must keep every backend-independent row`,
      ).toEqual(referenceOthers.map(row => row.id))
    }
  })

  it.skipIf(reference === undefined)('each tier preset carries that tier as its EF mode', () => {
    // The mode is what makes the three presets distinct; a copy-paste that left
    // them all on one tier would pass every other check here.
    for (const tier of TIER_MODE_NAMES) {
      const file = join(ROOT, 'presets', `ef-${tier}.patch.yml`)
      const group = pluginsOf(file, `preset-ef-${tier}`).find(row => row.id === 'compaction')
      const efRow = innerRows(group!).find(row => row.id === 'epistemic-fold')
      expect(
        JSON.stringify(efRow?.config),
        `ef-${tier} must set mode: ${tier}`,
      ).toContain(`"mode":"${tier}"`)
    }
  })

  it('the package declares all three presets as bundle patches', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string | string[] } }
      files?: string[]
    }
    const declared = pkg.dsh?.bundle?.patch
    const list = Array.isArray(declared) ? declared : [declared]
    for (const tier of TIER_MODE_NAMES) {
      expect(list, `package.json must list presets/ef-${tier}.patch.yml`).toContain(`./presets/ef-${tier}.patch.yml`)
    }
    expect(pkg.files, 'the presets directory must ship').toContain('presets')
  })

  it('states the mirror contract even when no DSH is installed', () => {
    for (const tier of TIER_MODE_NAMES) {
      expect(existsSync(join(ROOT, 'presets', `ef-${tier}.patch.yml`)), `ef-${tier} must exist`).toBe(true)
    }
    if (reference === undefined) {
      console.log(
        'RC5 DRIFT: no installed DSH found, so the mirror was NOT verified. '
        + 'Run on a machine with a DSH profile to check it.',
      )
    }
  })
})
