/**
 * RC7-T2: the in-place preset block stays honest against the installed DSH.
 *
 * ## Why this test exists
 *
 * `cordis.patch.yml`'s generated block RESTATES each shipped preset's whole
 * `config`, because the Loader cannot address a row nested in `config.plugins`.
 * That makes it a copy of DSH's own preset rows, and a copy rots: DSH changes a
 * preset, the block does not, and the user's sessions silently diverge from what
 * EF's tests assert.
 *
 * RC5 had this test for EF's own presets. It is repurposed here rather than
 * deleted, because the hazard is the same and the artifact changed.
 *
 * ## What it asserts
 *
 *  1. Every target preset in the block matches the installed reference
 *     ROW FOR ROW, except for the three intended edits inside the compaction
 *     group (backend name, EF config, the added isolate key).
 *  2. `minimal` appears NOWHERE in the block: EF deliberately leaves it alone,
 *     and a future edit that started substituting it would change what
 *     "minimal" means.
 *  3. The block is bounded by its markers, so regeneration replaces its own
 *     output instead of appending a second copy.
 *
 * ## Environment
 *
 * Like the RC5 drift test, this needs an installed DSH to compare against. It
 * skips where none is present rather than failing, because a contributor without
 * a web profile can still run every other suite.
 *
 * @module tests/rc7-inplace-drift
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PATCH_FILE = join(ROOT, 'cordis.patch.yml')
const BEGIN = '# >>> epistemic-fold preset overrides'
const END = '# <<< epistemic-fold preset overrides'

/** The presets EF substitutes into. `minimal` is deliberately absent. */
const TARGETS = ['standard', 'ptc', 'cordis'] as const

/** Locate the installed DSH's shipped presets, or undefined. */
function referenceDir(): string | undefined {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const base = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  return [
    join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets'),
    join(base, 'dsh-web-app', 'presets'),
  ].find(candidate => existsSync(candidate))
}

/**
 * The YAML reader, loaded from the DSH installation.
 *
 * The repository has no YAML dependency, and adding one to compare two files
 * would be a dependency bought for a test. DSH already ships `js-yaml`, and this
 * test only runs on a machine that has DSH installed.
 */
interface YamlReader {
  load(text: string): unknown
}
function yamlReader(): YamlReader {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const requireFrom = createRequire(join(home, 'profiles', 'package.json'))
  const yaml = requireFrom('js-yaml') as {
    Type: new (tag: string, options: { kind: string; construct: (d: string) => string }) => unknown
    DEFAULT_SCHEMA: { extend(types: unknown[]): unknown }
    load(text: string, options: { schema: unknown }): unknown
  }
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d: string) => d })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  return { load: (text: string) => yaml.load(text, { schema }) }
}

/**
 * One preset row as the loader's schema parses it.
 *
 * NOTE the shape: a preset row's `config` is an OBJECT holding `plugins`, not an
 * array. That is exactly why the Loader cannot address a nested row by id — it
 * indexes only rows with `group: true` AND an array `config` — and therefore why
 * this file restates whole presets instead of patching one row.
 */
interface PresetRow {
  readonly id?: string
  readonly name?: string
  readonly config?: { readonly plugins?: readonly GroupRow[] }
}

/** One row INSIDE a preset's plugin list; a group carries an array `config`. */
interface GroupRow {
  readonly id?: string
  readonly name?: string
  readonly isolate?: Record<string, boolean>
  readonly config?: readonly GroupRow[]
}

/** Extract one preset's `config.plugins` from a shipped patch file. */
function shippedPlugins(dir: string, name: string, yaml: YamlReader): readonly GroupRow[] {
  const parsed = yaml.load(readFileSync(join(dir, `${name}.patch.yml`), 'utf8')) as Array<{
    insert?: Array<{ id?: string; config?: { plugins?: readonly GroupRow[] } }>
  }>
  const preset = parsed[0]?.insert?.[0]
  if (preset?.config?.plugins === undefined) throw new Error(`${name}: no preset plugins found`)
  return preset.config.plugins
}

/** Extract the EF block's override rows from the checked-in patch file. */
function generatedRows(yaml: YamlReader): readonly PresetRow[] {
  const text = readFileSync(PATCH_FILE, 'utf8')
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start === -1 || end === -1) throw new Error('cordis.patch.yml is missing its generated markers')
  return yaml.load(text.slice(start, end)) as readonly PresetRow[]
}

const dir = referenceDir()
const describeIfDsh = dir === undefined ? describe.skip : describe

describeIfDsh('RC7-T2: the in-place preset block matches the installed DSH', () => {
  it('every target preset is present, and `minimal` is absent by design', () => {
    const rows = generatedRows(yamlReader())
    expect(rows.map(row => row.id).sort()).toEqual(TARGETS.map(name => `preset-${name}`).sort())
    // `minimal` ships with NO compaction group, so EF leaves it exactly as DSH
    // ships it. Substituting it would change what "minimal" means.
    expect(rows.some(row => row.id === 'preset-minimal')).toBe(false)
  })

  it('each preset differs from the reference ONLY inside the compaction group', () => {
    const yaml = yamlReader()
    for (const row of generatedRows(yaml)) {
      const name = String(row.id).replace('preset-', '')
      const reference = shippedPlugins(dir!, name, yaml)
      const generated = row.config?.plugins ?? []
      expect(generated.length, `${name}: row count must match the reference`).toBe(reference.length)

      for (const [index, refRow] of reference.entries()) {
        const genRow = generated[index]!
        expect(genRow.id, `${name}[${index}]: row identity must match`).toBe(refRow.id)
        if (refRow.id !== 'compaction') {
          // Everything outside the compaction group must be byte-identical in
          // structure. This is the property that makes the preset a mirror
          // rather than a fork.
          expect(JSON.stringify(genRow), `${name}: ${String(refRow.id)} must be untouched`)
            .toBe(JSON.stringify(refRow))
        }
      }
    }
  })

  it('the compaction group keeps its realm and swaps only the backend', () => {
    const yaml = yamlReader()
    for (const row of generatedRows(yaml)) {
      const name = String(row.id).replace('preset-', '')
      const reference = shippedPlugins(dir!, name, yaml)
      const generated = row.config?.plugins ?? []
      const refGroup = reference.find(r => r.id === 'compaction')!
      const genGroup = generated.find(r => r.id === 'compaction')!
      const refChildren = refGroup.config ?? []
      const genChildren = genGroup.config ?? []

      // Same children, same order: only the backend's name and config change.
      expect(genChildren.map(c => c.id)).toEqual(refChildren.map(c => c.id))
      const backend = genChildren.find(c => c.id === 'compaction-basic')!
      // The PLUGIN subpath, never the bare package name.
      //
      // This assertion previously read `toBe('dsh-epistemic-fold')`, which is
      // what the bare name resolves to for the DOCTOR. So the test actively
      // protected the defect: the generator emitted a row that mounted an
      // observation-only module, the group had no `compaction` provider,
      // `command-compact` waited on it forever, and every session on the profile
      // failed to resume. The test passed the whole time.
      expect(backend.name, `${name}: the backend must be the EF plugin subpath`)
        .toBe('dsh-epistemic-fold/plugin')

      // The pruner row must SURVIVE. This is the §14 defect: the top-level
      // variant lost it silently, because the engine that calls it could not
      // see it. In-place substitution keeps the group intact, so it cannot.
      expect(
        genChildren.some(c => c.id === 'tool-result-pruner'),
        `${name}: tool-result-pruner must remain in the group`,
      ).toBe(true)

      // The realm must be EXTENDED, not replaced: `compaction` and
      // `toolResultPruner` are DSH's, and dropping either would break a sibling
      // row (measured: `command-compact` waits forever without its realm).
      expect(genGroup.isolate?.['compaction'], `${name}: must keep DSH's compaction realm`).toBe(true)
      expect(genGroup.isolate?.['toolResultPruner'], `${name}: must keep DSH's pruner realm`).toBe(true)
      expect(genGroup.isolate?.['epistemicFold'], `${name}: must add EF's realm`).toBe(true)
    }
  })

  it('the generated block is bounded by its markers', () => {
    // Without markers, regeneration would append a second copy of every
    // override and which one applies would depend on file order.
    const text = readFileSync(PATCH_FILE, 'utf8')
    expect(text.indexOf(BEGIN)).toBeGreaterThan(-1)
    expect(text.indexOf(END)).toBeGreaterThan(text.indexOf(BEGIN))
    // ...and nothing hand-written may sit INSIDE the block.
    const inside = text.slice(text.indexOf(BEGIN), text.indexOf(END))
    expect(inside).not.toContain('# dsh-epistemic-fold bundle patch')
  })
})
