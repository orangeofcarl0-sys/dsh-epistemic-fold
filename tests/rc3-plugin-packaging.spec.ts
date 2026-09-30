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

  it('declares the bundle patches a profile loader consumes', async () => {
    // RC5 made this an ARRAY, the same shape `dsh-web-app` uses for its own
    // presets: one patch file per tier, plus the (now empty) top-level file.
    const pkg = await readJson('package.json')
    const dsh = pkg['dsh'] as { bundle?: { patch?: string | string[] } } | undefined
    const declared = dsh?.bundle?.patch
    expect(Array.isArray(declared), 'the patch list must be an array').toBe(true)
    const list = declared as string[]
    expect(list).toContain('./cordis.patch.yml')
    for (const tier of ['ef-economy', 'ef-balanced', 'ef-quality']) {
      expect(list).toContain(`./presets/${tier}.patch.yml`)
    }
    // Every referenced file must actually ship.
    for (const entry of list) {
      await expect(access(join(ROOT, entry)), `${entry} must exist`).resolves.toBeUndefined()
    }
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

describe('RC5: the presets replace the compaction backend, per session', () => {
  it('declares one preset per tier, each mounting EF in its compaction group', async () => {
    // RC3 mounted EF at the TOP level and disabled the top-level
    // `compaction-basic`. RC4-A found that is a NO-OP in a web profile, because
    // `dsh-web-app` already disables that row and puts a compaction group inside
    // each agent preset, isolated — so a top-level EF was invisible to every
    // session. RC5 declares EF's OWN presets instead.
    for (const tier of ['ef-economy', 'ef-balanced', 'ef-quality']) {
      const patch = await readFile(join(ROOT, 'presets', `${tier}.patch.yml`), 'utf8')
      expect(patch, `${tier} must declare a preset row`).toContain(`id: preset-${tier}`)
      expect(patch).toContain('@deepseek-ai/dsh-agent-preset')
      // EF replaces Basic inside the group...
      expect(patch).toContain('name: dsh-epistemic-fold')
      expect(patch).not.toContain("name: '@deepseek-ai/dsh-compaction-basic'")
      // ...and the realm is isolated, or the second preset to mount collides.
      expect(patch, `${tier} must isolate epistemicFold`).toContain('epistemicFold: true')
    }
  })

  it('the top-level patch no longer mounts EF over DSH', async () => {
    // It is deliberately empty: mounting EF globally is what failed. A row here
    // would re-introduce the invisible-EF problem in every preset-based profile.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    const rows = patch.split(String.fromCharCode(10))
      .filter(line => line.trim().startsWith('- id:'))
    expect(rows, 'the top-level patch must declare no rows').toEqual([])
  })

  it('each tier preset pins its own mode', async () => {
    for (const tier of ['economy', 'balanced', 'quality']) {
      const patch = await readFile(join(ROOT, 'presets', `ef-${tier}.patch.yml`), 'utf8')
      // A word boundary, so `mode: economy` cannot be satisfied by a longer
      // tier name that merely starts with it.
      expect(patch, `ef-${tier} must set mode: ${tier}`)
        .toMatch(new RegExp(`mode: ${tier}(?![a-z])`, 'u'))
    }
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
