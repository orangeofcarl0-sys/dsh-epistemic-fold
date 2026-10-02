/**
 * RC3: the plugin must be LOADABLE by a real DSH.
 *
 * Through RC2.1 this package could not be mounted in a harness at all: its entry
 * was raw TypeScript, it declared no bundle patch, and its library face and its
 * plugin face were the same export. The tests here pin the packaging contract so
 * that cannot regress — every one of them corresponds to a failure that was
 * actually observed while mounting EF into a real DSH 0.2.0-rc.2 install.
 *
 * @module tests/rc3-plugin-packaging
 */

import { describe, expect, it } from 'vitest'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness } from './harness.ts'

const ROOT = join(import.meta.dirname, '..')

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8')) as Record<string, unknown>
}

describe('RC3: the package declares a real plugin entry', () => {
  it('points `main` and the `.` export at the BUILT plugin entry', async () => {
    // THE DEFECT THIS PINS: `main` was `src/index.ts`. A real DSH `import()`s
    // that entry, and Node cannot execute TypeScript — the boot failed with
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before any plugin code ran.
    const pkg = await readJson('package.json')
    expect(pkg['main']).toBe('lib/entry.js')
    const exports = pkg['exports'] as Record<string, unknown>
    // `.` is what the loader resolves when a profile row names this package, so
    // it must be the PLUGIN, not the library. The library face lives at
    // `./library` for programmatic consumers.
    expect(exports['.']).toEqual({ types: './src/entry.ts', default: './lib/entry.js' })
    expect(exports['./library']).toBeDefined()
  })

  it('declares the bundle patch a profile loader consumes', async () => {
    // RC7: ONE patch file. It carries the in-place preset overrides plus the
    // doctor row, so there is a single artifact to ship, install and reason
    // about. RC5's array of three per-tier preset files is retired.
    const pkg = await readJson('package.json')
    const dsh = pkg['dsh'] as { bundle?: { patch?: string | string[] } } | undefined
    const declared = dsh?.bundle?.patch
    expect(declared, 'the patch must be declared').toBe('./cordis.patch.yml')
    await expect(access(join(ROOT, './cordis.patch.yml')), 'the patch must exist').resolves.toBeUndefined()
    // The retired per-tier files must NOT be declared, or an install would fail
    // on a missing path.
    expect(JSON.stringify(declared)).not.toContain('presets/')
  })

  it('ships `lib` in `files`, or an install would omit the entry', async () => {
    const pkg = await readJson('package.json')
    expect(pkg['files']).toContain('lib')
    expect(pkg['files']).toContain('cordis.patch.yml')
  })

  it('has a build script, so `lib/` can be produced', async () => {
    const pkg = await readJson('package.json')
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['build']).toBeDefined()
  })
})

describe("RC7: the patch substitutes EF into DSH's own presets, in place", () => {
  it('rewrites only the compaction backend inside each shipped preset', async () => {
    // RC3 mounted EF at the TOP level and disabled the top-level
    // `compaction-basic`. RC4-A found that is a NO-OP in a web profile, because
    // `dsh-web-app` already disables that row and puts a compaction group inside
    // each agent preset, isolated — so a top-level EF was invisible to every
    // session. RC5 declared EF's own presets, which worked but added three menu
    // items. RC7 substitutes the backend INSIDE the shipped presets instead, so
    // the menu is unchanged and nothing else about a preset moves.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    for (const name of ['standard', 'ptc', 'cordis']) {
      expect(patch, `${name} must be overridden`).toContain(`- id: preset-${name}`)
    }
    // `minimal` ships with NO compaction group, so EF deliberately leaves it
    // exactly as DSH ships it. Substituting it would change what "minimal" means.
    expect(patch, 'minimal must not be substituted').not.toContain('- id: preset-minimal')

    expect(patch).toContain('name: dsh-epistemic-fold')
    // The realm must be EXTENDED, not replaced: DSH's own two keys stay.
    expect(patch).toContain('epistemicFold: true')
    expect(patch).toMatch(/^ {18}compaction: true$/mu)
    expect(patch).toMatch(/^ {18}toolResultPruner: true$/mu)
  })

  it('mounts the doctor OUTSIDE the generated block', async () => {
    // EF is mounted BY the substitution, so when the substitution misses, EF
    // never mounts — and a check living inside EF can never run. The doctor
    // therefore mounts at the top level, where it always runs. Its row must sit
    // outside the generated markers, or a regeneration would delete it.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    const begin = patch.indexOf('# >>> epistemic-fold preset overrides')
    expect(begin).toBeGreaterThan(-1)
    expect(patch.slice(0, begin)).toContain('epistemic-fold-doctor')
    // ...and the package must export the subpath that row names.
    const pkg = await readJson('package.json')
    const exports = pkg['exports'] as Record<string, unknown>
    expect(exports['./doctor'], 'the doctor subpath must be exported').toBeDefined()
  })

  it('mounts no EF row of its own beyond the doctor', async () => {
    // A second mount path would re-introduce the invisible-EF problem in every
    // preset-based profile: the substitution is the only way EF reaches a
    // session. The doctor is the sole exception, and it is observation-only.
    //
    // The property is stated as "which plugin names this patch mounts", not as
    // an indent filter: preset rows, their nested plugin rows, and top-level
    // rows all appear at various indents, so indentation cannot distinguish a
    // mount path. The plugin NAME can.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    const names = patch.split(String.fromCharCode(10))
      .map(line => line.trim())
      .filter(line => line.startsWith('name: '))
      .map(line => line.slice('name: '.length).replace(/^['"]|['"]$/gu, ''))

    // Exactly ONE top-level row mounts from this package: the doctor. The three
    // `dsh-epistemic-fold/plugin` rows are the SUBSTITUTION rows, nested inside
    // each preset's compaction group — that is what replaces Basic, and they are
    // reached only through a preset, never on their own.
    const topLevel = patch.slice(0, patch.indexOf('# >>> epistemic-fold preset overrides'))
      .split(String.fromCharCode(10))
      .map(line => line.trim())
      .filter(line => line.startsWith('name: '))
      .map(line => line.slice('name: '.length).replace(/^['"]|['"]$/gu, ''))
    // The BARE package name: DSH's client roster only recognises an exact
    // package specifier (no slash), and a package it cannot recognise loses its
    // browser half. See the entry test below.
    expect(topLevel).toEqual(['dsh-epistemic-fold'])

    // ...and the two specifiers are counted EXACTLY, so a new mount path cannot
    // appear unnoticed. They are DIFFERENT specifiers, and conflating them was
    // the defect: the bare name resolves to the doctor (which provides no
    // service), so a preset row naming it mounts a module that cannot register
    // `ctx.compaction`, and every session on the profile fails to resume.
    //
    //   dsh-epistemic-fold          x1  the top-level doctor row (bare, for the
    //                                   client roster; see the entry test below)
    //   dsh-epistemic-fold/plugin   x3  the substitution rows, one per preset
    expect(names.filter(name => name === 'dsh-epistemic-fold').length).toBe(1)
    expect(names.filter(name => name === 'dsh-epistemic-fold/plugin').length).toBe(3)
    expect(names.filter(name => name === '@deepseek-ai/dsh-agent-preset').length).toBe(3)
  })
})

describe('RC7: the bare-name entry mounts the doctor, not the plugin', () => {
  it('exports name, inject and a default mount function', async () => {
    const entry = await import('../src/entry.ts')
    expect(entry.name).toBe('epistemic-fold-doctor')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(typeof entry.default).toBe('function')
    expect(typeof entry.apply).toBe('function')
  })

  it('the bare name is load-bearing, and only the doctor may hold it', async () => {
    // DSH's client module system finds a package's browser half by scanning the
    // host Loader for a row whose `name` is an EXACT package specifier — a bare
    // name with no slash. `exactPackageSpecifier('dsh-epistemic-fold')` is
    // accepted; `.../doctor` is rejected. A package whose only top-level row uses
    // a subpath is therefore skipped entirely, and its `client.js` never reaches
    // the browser — which silently drops the Sidebar panel AND, because the
    // client declared a hard `inject`, fails the whole web boot.
    //
    // So the bare name must be held by a row that ALWAYS mounts and is
    // observation-only. That is the doctor.
    const entry = await import('../src/entry.ts')
    const source = await readFile(join(ROOT, 'src', 'entry.ts'), 'utf8')
    // It must be the doctor...
    expect(entry.name).toContain('doctor')
    // ...and it must NOT be the plugin: mounting the plugin at the root would
    // create a second engine whose surface reports on sessions it never folds.
    expect(source).not.toContain("from './plugin.ts'")
  })

  it('the plugin stays reachable at its own subpath', async () => {
    // A preset-based profile mounts the plugin per preset; a preset-free
    // deployment (headless/CLI) mounts it explicitly. Either way it must be
    // importable without going through the doctor.
    const pkg = await readJson('package.json')
    const exports = pkg['exports'] as Record<string, unknown>
    expect(exports['./plugin']).toBeDefined()
    expect(exports['./doctor']).toBeDefined()
    const entry = await import('../src/plugin.ts')
    expect(entry.EpistemicFoldPlugin).toBeDefined()
  })

  it('the client declares NO hard inject, so a missing sidebar cannot fail boot', () => {
    // `betterSidebar` belongs to a third-party plugin a deployment may not have.
    // A declared `inject: ['betterSidebar']` holds the entry pending forever —
    // measured in a real web boot with no dsh-better-sidebar installed:
    //
    //   Failed to load plugins
    //   web boot: 1 entry did not activate dsh-epistemic-fold:
    //   pending (waiting for service: betterSidebar)
    //
    // That fails the WHOLE UI, not just the panel. The optional-service idiom is
    // `ctx.inject([...], cb)` inside apply().
    const client = require('node:fs').readFileSync(join(ROOT, 'client.js'), 'utf8')
    expect(client, 'the client must use ctx.inject for the optional service')
      .toContain("ctx.inject(['betterSidebar']")
    expect(client, 'the client must NOT declare a hard inject list')
      .not.toMatch(/const inject = \['betterSidebar'\]/u)
  })
})

describe('RC3: conditional mounts never throw on a missing service', () => {
  it('mounts with NO ToolRuntime and NO CommandRuntime', async () => {
    // THE DEFECT THE REAL BOOT FOUND: `ctx.get('tools')` THROWS in cordis when
    // `tools` is not declared in `inject`, and every test harness had
    // pre-mounted a ToolRuntime so the broken probe was unreachable. The first
    // real DSH boot failed with `cannot get property "tools" without inject`.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      // Neither tools nor commands.
      efConfig: { mode: 'legacy' },
    })
    expect(harness.plugin).toBeDefined()
    expect(harness.ctx.get('tools')).toBeUndefined()
    expect(harness.ctx.get('commands')).toBeUndefined()
  }, 120_000)

  it('registers the recall tools once a ToolRuntime appears', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      tools: true,
      efConfig: { mode: 'legacy' },
    })
    // `ctx.inject` is ASYNC: the child fiber starts after the constructor
    // returns, so a test that checks immediately sees nothing. That timing is
    // exactly what made an earlier probe of this report wrongly conclude the
    // command was not registered.
    await new Promise(resolve => setTimeout(resolve, 100))
    // `get` is the registered-tool lookup; the recall tools must be there.
    expect(harness.ctx.tools.get('context_search')).toBeDefined()
    expect(harness.ctx.tools.get('context_recall')).toBeDefined()
  }, 120_000)

  it('registers /context once a CommandRuntime appears', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      commands: true,
      efConfig: { mode: 'legacy' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const names = harness.ctx.commands.list({ id: 'probe' } as never).map(command => command.name)
    expect(names).toContain('context')
  }, 120_000)
})
