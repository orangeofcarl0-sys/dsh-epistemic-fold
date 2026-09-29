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
import { EpistemicFoldPlugin } from '../src/plugin.ts'

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
    const pkg = await readJson('package.json')
    const dsh = pkg['dsh'] as { bundle?: { patch?: string } } | undefined
    expect(dsh?.bundle?.patch).toBe('cordis.patch.yml')
    // The referenced file must actually ship.
    await expect(access(join(ROOT, 'cordis.patch.yml'))).resolves.toBeUndefined()
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

describe('RC3: the patch replaces the compaction backend', () => {
  it('inserts EF and DISABLES compaction-basic', async () => {
    // EF owns `ctx.compaction`; Cordis allows one registration per service. A
    // profile with both active fails to boot, so the disable is load-bearing
    // rather than tidiness.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: dsh-epistemic-fold')
    expect(patch).toMatch(/id:\s*compaction-basic\s*\n\s*disabled:\s*true/u)
  })

  it('ships a seam-free mode, so it mounts on an unpatched harness', async () => {
    // Every tier selects `system-dedup`, which REQUIRES the `frameCheckpoint`
    // seam — absent from released DSH. Shipping a tier here would make the
    // profile abort at boot on a vanilla install.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/mode:\s*legacy/u)
    expect(patch).not.toMatch(/^\s*mode:\s*(economy|balanced|quality)/mu)
  })
})

describe('RC3: the plugin entry exposes what the loader reads', () => {
  it('exports name, inject, Config and a default plugin class', async () => {
    const entry = await import('../src/entry.ts')
    expect(entry.name).toBe('epistemic-fold')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(entry.Config).toBeDefined()
    expect(typeof entry.default).toBe('function')
  })

  it('does NOT require the optional services it mounts conditionally', () => {
    // `tools` and `commands` are optional siblings: a compaction-only deployment
    // must mount without them. Listing them in `inject` would make the whole
    // plugin wait for services a deployment may never compose.
    const entry = require_entry_inject()
    expect(entry).not.toContain('tools')
    expect(entry).not.toContain('commands')
  })
})

/** The entry's inject list, read once for the assertion above. */
function require_entry_inject(): readonly string[] {
  return EpistemicFoldPlugin.inject
}

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
