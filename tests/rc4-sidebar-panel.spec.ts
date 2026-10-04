/**
 * RC4: the Sidebar panel is an observation plane over the SAME model.
 *
 * The directive's architecture is one sentence: **command = control, Sidebar =
 * observation**, and both render ONE `ContextStatus` rather than the panel
 * running the command and parsing its text. These tests pin the three things
 * that make that true:
 *
 *  1. the projection is a pure fold over session events, so it cannot reach into
 *     the bundle store or the meter and silently disagree with the command;
 *  2. it carries figures the command CANNOT (the meter's own `shadowedTokenCount`
 *     rather than a `chars/4` heuristic), and labels them accordingly;
 *  3. the client bundle loads under the real loader contract, registers exactly
 *     one tab, and renders `—` for an unknown figure rather than a zero.
 *
 * @module tests/rc4-sidebar-panel
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHarness } from './harness.ts'
import {
  epistemicFoldStatusProjection,
  EF_STATUS_KEY,
  reduceStatusEvent,
} from '../src/status-projection.ts'
import type { FoldStatusState } from '../src/status-projection.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'

const ROOT = join(import.meta.dirname, '..')

/** A configuration-free empty state, for direct fold tests. */
function emptyState(overrides: Partial<FoldStatusState> = {}): FoldStatusState {
  const unit = epistemicFoldStatusProjection({ mode: 'economy' })
  return { ...unit.init(), ...overrides }
}

describe('RC4: the projection is a pure fold over committed events', () => {
  it('seeds the mode from configuration, since a switch is not an event', () => {
    expect(epistemicFoldStatusProjection({ mode: 'balanced' }).init().mode).toBe('balanced')
  })

  it('accumulates the meter\'s OWN shadowed count, not a chars/4 estimate', () => {
    // THE FIGURE THE COMMAND CANNOT PRODUCE. `/context status` sums archived
    // message text and divides by 4, which is a heuristic and is labelled
    // `estimated`. `shadowedTokenCount` is the token meter's own number for the
    // span the fold replaced, so the panel's figure is measured. The two
    // renderers disagree, and one of them has better data.
    const after = reduceStatusEvent(emptyState(), {
      type: 'compaction/summary', seq: 1, time: 0,
      data: { shadowedTokenCount: 12_345, summary: [{ type: 'text', text: '[EF1 L cp:abc]' }] },
    } as never)
    expect(after.archivedTokens).toBe(12_345)
  })

  it('classifies leaf vs root from EF\'s own marker', () => {
    const leaf = reduceStatusEvent(emptyState(), {
      type: 'compaction/summary', seq: 1, time: 0,
      data: { shadowedTokenCount: 100, summary: [{ type: 'text', text: '[EF1 L cp:a]' }] },
    } as never)
    expect([leaf.folds, leaf.roots]).toEqual([1, 0])

    const root = reduceStatusEvent(emptyState(), {
      type: 'compaction/summary', seq: 2, time: 0,
      data: { shadowedTokenCount: 100, summary: [{ type: 'text', text: '[EF1 R cp:b]' }] },
    } as never)
    expect([root.folds, root.roots]).toEqual([0, 1])
  })

  it('counts recall and search calls by tool name', () => {
    let state = emptyState()
    for (const name of ['context_search', 'context_recall', 'context_recall', 'read']) {
      state = reduceStatusEvent(state, { type: 'tool/call', seq: 1, time: 0, data: { name } } as never)
    }
    expect(state.searches).toBe(1)
    expect(state.recalls).toBe(2)
  })

  it('accumulates provider usage, deriving the uncached part', () => {
    // `inputTokens` is the whole prompt and `cacheReadTokens` the cached part
    // INSIDE it, so uncached is the difference. Adding the raw input would
    // double-count the cached prefix in every cost figure.
    const state = reduceStatusEvent(emptyState(), {
      type: 'assistant/message', seq: 1, time: 0,
      data: { usage: { inputTokens: 1_000, cacheReadTokens: 400, cacheWriteTokens: 10, outputTokens: 50 } },
    } as never)
    expect(state.uncachedInputTokens).toBe(600)
    expect(state.cacheReadTokens).toBe(400)
    expect(state.cacheWriteTokens).toBe(10)
    expect(state.outputTokens).toBe(50)
    expect(state.hasUsage).toBe(true)
  })

  it('detects a resume boundary from the header reason', () => {
    const state = reduceStatusEvent(emptyState(), {
      type: 'request/header', seq: 1, time: 0, data: { reason: 'resume' },
    } as never)
    expect(state.resumed).toBe(true)
  })

  it('counts a FAILED compaction without counting it as a fold', () => {
    // The fold count comes from `compaction/summary`, so counting at
    // `compaction/end` too would double every successful fold.
    const state = reduceStatusEvent(emptyState(), {
      type: 'compaction/end', seq: 1, time: 0, data: { error: 'boom' },
    } as never)
    expect(state.failedCompactions).toBe(1)
    expect(state.folds).toBe(0)
  })

  it('leaves unrelated events untouched, by reference', () => {
    // The registry relies on `Object.is` to suppress downstream work, so an
    // uninterested event MUST return the same reference.
    const state = emptyState()
    const after = reduceStatusEvent(state, { type: 'turn/start', seq: 1, time: 0, data: {} } as never)
    expect(after).toBe(state)
  })
})

describe('RC4: the wire view carries how each figure was obtained', () => {
  it('prices the cost and names the profile', () => {
    const profile = parseEconomicsProfile({
      id: 'p', provider: 'test', modelPattern: '*', asOf: '2026-09-30',
      pricing: { inputMissPerM: 1, inputHitPerM: 0, outputPerM: 1 },
      cache: { mode: 'automatic', bestEffort: true },
      context: { windowTokens: 1_000 },
    })
    const unit = epistemicFoldStatusProjection({ mode: 'economy', profiles: [profile] })
    // RC18: the state carries the routed model, folded from `request/header`.
    // Pricing depends on it now, so a state without one is a session that has
    // not made a request yet.
    const state = {
      ...unit.init(),
      provider: 'test', model: 'test-model',
      uncachedInputTokens: 1_000, hasUsage: true,
    }
    const view = unit.wire.view(state)
    expect(view.cost).toBeCloseTo(0.001, 9)
    expect(view.costProfileId).toBe('p')
  })

  it('reports cost as NULL, never 0, when there is no usage to price', () => {
    // The rule the whole status surface is built on: an unestablished figure and
    // a measured zero mean opposite things, and a `0` cost would read as "this
    // mode is free".
    const unit = epistemicFoldStatusProjection({
      mode: 'economy',
      profiles: [parseEconomicsProfile({
        id: 'p', provider: 'test', modelPattern: '*', asOf: '2026-09-30',
        pricing: { inputMissPerM: 1, inputHitPerM: 0, outputPerM: 1 },
        cache: { mode: 'automatic', bestEffort: true },
        context: { windowTokens: 1_000 },
      })],
    })
    const view = unit.wire.view(unit.init())
    expect(view.cost).toBeNull()
    expect(view.usage).toBeNull()
  })

  it('reports cost as NULL when no profile is configured', () => {
    const unit = epistemicFoldStatusProjection({ mode: 'economy' })
    const state = { ...unit.init(), uncachedInputTokens: 5_000, hasUsage: true }
    expect(unit.wire.view(state).cost).toBeNull()
  })

  it('RC18: prices with the list for THIS session\'s model, not the first one', () => {
    // THE DEFECT THIS PINS, seen in the real panel. The plugin passed
    // `profiles[0]` — the first shipped list — so every session was priced with
    // DeepSeek Flash's rates and the panel named that list beside the figure.
    // A session on Space Bunny Free (a free route) showed `~0.0044` under
    // `Priced with deepseek-flash-2026-09`: 15.9k tokens at 0.28/M, for a route
    // with no prices of its own. The number was not merely mislabelled; it was
    // computed from the wrong rate card.
    const flash = parseEconomicsProfile({
      id: 'deepseek-flash', provider: 'deepseek', modelPattern: 'deepseek-*flash*', asOf: '2026-09-30',
      pricing: { inputMissPerM: 0.28, inputHitPerM: 0.0056, outputPerM: 0.42 },
      cache: { mode: 'automatic', bestEffort: true }, context: { windowTokens: 131_072 },
    })
    const free = parseEconomicsProfile({
      id: 'synthetic-no-cache', provider: 'synthetic', modelPattern: '*', asOf: '2026-09-30',
      pricing: { inputMissPerM: 1, inputHitPerM: 1, outputPerM: 1 },
      cache: { mode: 'none', bestEffort: false }, context: { windowTokens: 128_000 },
    })
    const unit = epistemicFoldStatusProjection({ mode: 'economy', profiles: [flash, free] })

    // The session that produced the screenshot: a free OpenCode Zen route, for
    // which this deployment has no price list at all.
    const state = {
      ...unit.init(),
      provider: 'opencode-zen', model: 'space-bunny-free',
      uncachedInputTokens: 15_900, hasUsage: true,
    }
    const view = unit.wire.view(state)
    expect(view.costProfileId, 'a free route must not be priced as DeepSeek Flash').toBeNull()
    // UNKNOWN, not a number: `synthetic-no-cache` is a synthetic card whose
    // 1.0/M is made up, so pricing with it would report a confident `~0.0159`
    // for a route that costs nothing. The panel renders `—` instead, and names
    // the route it could not price.
    expect(view.cost).toBeNull()
    expect(view.pricedRoute).toBe('opencode-zen/space-bunny-free')

    // A route the deployment DOES price still gets its own card — this is a
    // lookup, not a blanket refusal to price.
    const deepseek = unit.wire.view({
      ...state, provider: 'deepseek', model: 'deepseek-flash',
    })
    expect(deepseek.costProfileId).toBe('deepseek-flash')
    expect(deepseek.cost).toBeGreaterThan(0)
  })

  it('RC18: follows a mid-session model switch, because the header is folded', () => {
    // The route is read from the event log rather than captured at
    // registration, so a `change` header moves the price list with the model.
    const a = parseEconomicsProfile({
      id: 'list-a', provider: 'pa', modelPattern: 'ma', asOf: '2026-09-30',
      pricing: { inputMissPerM: 1, inputHitPerM: 1, outputPerM: 1 },
      cache: { mode: 'none', bestEffort: false }, context: { windowTokens: 1_000 },
    })
    const b = parseEconomicsProfile({
      id: 'list-b', provider: 'pb', modelPattern: 'mb', asOf: '2026-09-30',
      pricing: { inputMissPerM: 2, inputHitPerM: 2, outputPerM: 2 },
      cache: { mode: 'none', bestEffort: false }, context: { windowTokens: 1_000 },
    })
    const unit = epistemicFoldStatusProjection({ mode: 'economy', profiles: [a, b] })
    const header = (provider: string, model: string) => ({
      type: 'request/header', seq: 1, time: 0,
      data: { header: { config: { provider, model } }, reason: 'initial' },
    }) as never

    let state = reduceStatusEvent(unit.init(), header('pa', 'ma'))
    state = { ...state, uncachedInputTokens: 1_000, hasUsage: true }
    expect(unit.wire.view(state).costProfileId).toBe('list-a')

    state = reduceStatusEvent(state, {
      type: 'request/header', seq: 2, time: 0,
      data: { header: { config: { provider: 'pb', model: 'mb' } }, reason: 'change' },
    } as never)
    expect(unit.wire.view(state).costProfileId, 'the switch must move the price list')
      .toBe('list-b')
    expect(unit.wire.view(state).cost).toBeCloseTo(0.002, 6)
  })

  it('updates only the half of the route a header names', () => {
    // A `request/header` is folded field by field, not as an all-or-nothing
    // route: a header naming only a model must move the model and leave the
    // provider as it stands. Collapsing the pair into "a route" would silently
    // discard the change and price the session against its previous route —
    // which is why the reader returns each half independently, and why this is
    // pinned rather than left to the all-or-nothing test above.
    const profile = parseEconomicsProfile({
      id: 'half', provider: 'pa', modelPattern: 'mb', asOf: '2026-09-30',
      pricing: { inputMissPerM: 3, inputHitPerM: 3, outputPerM: 3 },
      cache: { mode: 'none', bestEffort: false }, context: { windowTokens: 1_000 },
    })
    const unit = epistemicFoldStatusProjection({ mode: 'economy', profiles: [profile] })

    let state = reduceStatusEvent(unit.init(), {
      type: 'request/header', seq: 1, time: 0,
      data: { header: { config: { provider: 'pa', model: 'ma' } }, reason: 'initial' },
    } as never)
    expect(state.provider).toBe('pa')
    expect(state.model).toBe('ma')

    state = reduceStatusEvent(state, {
      type: 'request/header', seq: 2, time: 0,
      data: { header: { config: { model: 'mb' } }, reason: 'change' },
    } as never)
    expect(state.model, 'the named half must move').toBe('mb')
    expect(state.provider, 'the unnamed half must stand').toBe('pa')

    // The move is only worth pinning because it is OBSERVABLE: it is what makes
    // the price list follow the session onto the new model.
    state = { ...state, uncachedInputTokens: 1_000, hasUsage: true }
    expect(unit.wire.view(state).costProfileId).toBe('half')
  })

  it('reports the LIVE mode, so a runtime switch is not stale in the panel', () => {
    // A `/context mode` switch of a RUNNING session must not leave the panel
    // showing the startup mode forever. The mode comes from a getter for that
    // reason: it is configuration, not an event, so the fold cannot carry it.
    let mode: 'economy' | 'quality' = 'economy'
    const unit = epistemicFoldStatusProjection({ mode: () => mode })
    const before = unit.wire.view(unit.init())
    expect(before.mode).toBe('economy')
    mode = 'quality'
    const after = unit.wire.view(unit.init())
    expect(after.mode).toBe('quality')
    expect(after.isTier).toBe(true)
  })

  it('still accepts a plain mode value, for a report with no engine', () => {
    const unit = epistemicFoldStatusProjection({ mode: 'balanced' })
    expect(unit.wire.view(unit.init()).mode).toBe('balanced')
  })

  it('marks whether the mode is a tier, so the panel can say "default"', () => {
    expect(epistemicFoldStatusProjection({ mode: 'quality' }).wire.view(emptyState({ mode: 'quality' })).isTier).toBe(true)
    expect(epistemicFoldStatusProjection({ mode: 'legacy' }).wire.view(emptyState({ mode: 'legacy' })).isTier).toBe(false)
  })
})

describe('RC4: it registers on the real projection registry', () => {
  it('exposes the key the client reads', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072, plugin: true, systemPrompt: true,
      efConfig: { mode: 'legacy' },
    })
    const registry = harness.ctx.get('sessionProjections')
    expect(registry).toBeDefined()
    const session = Session.create(SessionId(`rc4-${Date.now()}`))
    // The unit is registered, so a snapshot can produce a value for its key.
    const snapshot = registry!.snapshot(session, [EF_STATUS_KEY])
    expect(snapshot).toBeDefined()
    expect(snapshot.values[EF_STATUS_KEY]).toBeDefined()
  }, 120_000)

  it('folds a real session into the view the panel renders', async () => {
    // End to end through the registry: record events, read the wire value.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072, plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy' },
    })
    const session = Session.create(SessionId(`rc4-fold-${Date.now()}`))
    session.append('request/header', {
      header: { config: { provider: 'p', model: 'm' } }, reason: 'resume',
    })
    session.append('tool/call', {
      turn: 1, step: 1, callId: 'c1' as never, name: 'context_search', arguments: '{}',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const registry = harness.ctx.get('sessionProjections')
    expect(registry).toBeDefined()
    const snapshot = registry!.snapshot(session, [EF_STATUS_KEY])
    const view = snapshot.values[EF_STATUS_KEY] as { searches: number; resumed: boolean; mode: string }
    expect(view.searches).toBe(1)
    expect(view.resumed).toBe(true)
    expect(view.mode).toBe('economy')
  }, 120_000)
})

describe('RC4: the client bundle satisfies the loader contract', () => {
  it('is declared as a client face with a web platform', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dsh?: { client?: { platform?: string; inject?: string[] } }
      exports: Record<string, unknown>
    }
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.exports['./client']).toBeDefined()
    // `dsh.client.inject` lists PACKAGE ids for module-graph ordering, not
    // service names: it is what makes the browser kernel load the sidebar-right
    // package before this client. The SERVICE the tab registers against is
    // `betterSidebar`, and it is optional — see the test below.
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
  })

  it('ships the client face in files and builds it into lib/', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('client.js')
    // The build copies it verbatim; a transpiled copy would rewrite React into
    // file paths the browser cannot resolve.
    const built = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
    const source = await readFile(join(ROOT, 'client.js'), 'utf8')
    expect(built).toBe(source)
  })

  it('loads under the real loader wrapper and registers exactly one tab', async () => {
    const source = await readFile(join(ROOT, 'client.js'), 'utf8')
    let captured: { id: string; mod: Record<string, unknown> } | undefined
    const jsxRuntime = { jsx: (t: unknown, p: unknown) => ({ t, p }), jsxs: (t: unknown, p: unknown) => ({ t, p }), Fragment: 'F' }
    const previous = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load: ({ id, factory }: { id: string; factory: (r: (n: string) => unknown) => Record<string, unknown> }) => {
          captured = {
            id,
            mod: factory(name => {
              if (name === 'react') return { createElement: () => ({}) }
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error(`unexpected require: ${name}`)
            }),
          }
        },
      },
    }
    try {
      // The bundle is a script for the browser loader, so it is evaluated the
      // way the loader would.
      // eslint-disable-next-line no-new-func
      new Function(source)()
    } finally {
      ;(globalThis as { window?: unknown }).window = previous
    }
    expect(captured?.id).toBe('dsh-epistemic-fold')
    expect(captured?.mod['name']).toBe('epistemic-fold')
    expect(typeof captured?.mod['apply']).toBe('function')
    // The module declares exactly ONE hard `inject`: `slots`.
    //
    // The two services are NOT alike, and the difference is the whole point.
    // `betterSidebar` belongs to a third-party plugin a deployment may not have,
    // so declaring it holds the entry pending forever — measured to fail the
    // WHOLE web boot, not just hide the panel — and it stays on `ctx.inject`.
    // `slots` is provided by `@deepseek-ai/dsh-client-ui-renderer`, the shell
    // that mounts this module at all, so it cannot be absent where this code
    // runs; and cordis refuses `ctx.slots` outright unless it is declared:
    //
    //   cannot get property "slots" without inject
    //
    // The native body seat is `ctx.slots.inject(...)`, so omitting it let the
    // tab TYPE register while the BODY threw, and the pane reported the
    // legitimate-looking "no available way to view this content".
    expect(captured?.mod['inject']).toEqual(['slots'])

    // Driving apply() against a context whose `inject` fires immediately
    // registers ONE tab with a stable id.
    // `component` is part of the captured descriptor on purpose: the earlier
    // type omitted it, which is exactly why nothing ever called it and the panel
    // shipped unable to render. Rendering is asserted in
    // tests/sidebar-panel-render.spec.ts, against the sidebar's real props.
    let tab: { id: string; single?: boolean; title: () => string; component?: unknown } | undefined
    const service = { registerTab: (descriptor: typeof tab) => { tab = descriptor; return () => { tab = undefined } } }
    // EF registers with BOTH sidebars — they keep separate tab registries — so
    // this stub answers each `inject` with the service that call asks for. The
    // native path is asserted in tests/sidebar-panel-render.spec.ts.
    const nativeTabs = { register: () => () => {} }
    const slots = { inject: (_name: string, cb: () => unknown) => cb(), register: () => () => {} }
    const ctx = {
      slots,
      inject: (names: readonly string[], cb: (c: unknown) => unknown) => {
        if (names.includes('betterSidebar')) {
          expect(names).toEqual(['betterSidebar'])
          return cb({ get: () => service })
        }
        // The native registration asks for the tab registry ONLY; `slots` is
        // read off the plugin's own ctx, as better-sidebar does.
        expect(names).toEqual(['sidebarRightTabs'])
        return cb({ get: () => nativeTabs })
      },
    }
    const apply = captured?.mod['apply'] as (c: unknown) => unknown
    apply(ctx)
    expect(tab?.id).toBe('epistemic-fold:status')
    expect(tab?.single).toBe(true)
    expect(tab?.title()).toBe('Epistemic Fold')
  })

  it('does nothing when no sidebar service is ever mounted', async () => {
    // A deployment without the sidebar plugin must still load the client face
    // rather than fail — the same conditional rule the host follows for
    // `ctx.tools`.
    //
    // The mechanism matters: the module's only hard `inject` is `slots` (always
    // present, see the export test above), and each SIDEBAR service is requested
    // through `ctx.inject([...], cb)`, whose callback simply never runs when the
    // service never appears. Declaring a sidebar service instead would hold the
    // entry pending forever, which was measured to fail the whole web boot.
    const source = await readFile(join(ROOT, 'client.js'), 'utf8')
    let mod: Record<string, unknown> | undefined
    const previous = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (r: (n: string) => unknown) => Record<string, unknown> }) => {
          mod = factory(name => (name === 'react/jsx-runtime'
            ? { jsx: () => ({}), jsxs: () => ({}), Fragment: 'F' }
            : { createElement: () => ({}) }))
        },
      },
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function(source)()
    } finally {
      ;(globalThis as { window?: unknown }).window = previous
    }
    const apply = mod?.['apply'] as (c: unknown) => unknown
    // A context where the optional services NEVER arrive: `inject` must be
    // called for EACH sidebar, and must not throw even though neither callback
    // fires. EF registers with both because they keep separate tab registries.
    const requested: (readonly string[])[] = []
    const ctx = { inject: (names: readonly string[]) => { requested.push(names) } }
    expect(() => apply(ctx)).not.toThrow()
    expect(requested).toEqual([['betterSidebar'], ['sidebarRightTabs']])
    // ...and a callback that DOES fire but finds no service must also not throw.
    const ctxEmpty = { inject: (_n: readonly string[], cb: (c: unknown) => unknown) => cb({ get: () => undefined }) }
    expect(() => apply(ctxEmpty)).not.toThrow()
  })
})

describe('RC17: the native half is a fallback, so the guide shows ONE entry', () => {
  /**
   * Load the client bundle the way the browser loader does and hand back its
   * `apply`.
   */
  async function loadApply() {
    const source = await readFile(join(ROOT, 'client.js'), 'utf8')
    let captured: Record<string, unknown> | undefined
    const jsxRuntime = { jsx: (t: unknown, p: unknown) => ({ t, p }), jsxs: (t: unknown, p: unknown) => ({ t, p }), Fragment: 'F' }
    const previous = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (r: (n: string) => unknown) => Record<string, unknown> }) => {
          captured = factory(name => (name === 'react/jsx-runtime'
            ? jsxRuntime
            : { createElement: () => ({}) }))
        },
      },
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function(source)()
    } finally {
      ;(globalThis as { window?: unknown }).window = previous
    }
    return captured?.['apply'] as (c: unknown) => void
  }

  /** A registry stub with the real API surface this code relies on. */
  function makeRegistry(initial: Record<string, unknown> = {}) {
    const kinds = new Map(Object.entries(initial))
    const listeners = new Set<() => void>()
    const registered: string[] = []
    return {
      kinds,
      registered,
      register: (definition: { id: string; kind: string }) => {
        registered.push(definition.id)
        kinds.set(definition.kind, definition)
        for (const listener of listeners) listener()
        // Identity-based, like the real disposer: it removes ITS OWN entry, not
        // whatever happens to be last.
        return () => {
          const at = registered.indexOf(definition.id)
          if (at !== -1) registered.splice(at, 1)
          kinds.delete(definition.kind)
          for (const listener of listeners) listener()
        }
      },
      get: (kind: string) => kinds.get(kind),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
  }

  it('registers NO native type when better-sidebar already bridged one', async () => {
    // THE DEFECT THIS PINS, measured in a real browser: better-sidebar bridges
    // every registered descriptor into the native registry, guide entry
    // included, so EF's own native registration added a SECOND "Epistemic Fold"
    // to the guide. Both entries had the same title, icon and behaviour, and the
    // kinds differed (`epistemic-fold:status` vs `dsh-epistemic-fold`), so the
    // registry's duplicate guard never fired. Picking either opened its own tab.
    const apply = await loadApply()
    // The bridge's output is already there, under EF's better-sidebar kind.
    const tabs = makeRegistry({ 'epistemic-fold:status': { id: 'dsh-better-sidebar:epistemic-fold:status' } })
    const slots = { inject: (_n: string, cb: () => unknown) => cb(), register: () => () => {} }
    const ctx = {
      slots,
      inject: (names: readonly string[], cb: (c: unknown) => unknown) =>
        (names.includes('betterSidebar') ? cb({ get: () => undefined }) : cb({ get: () => tabs })),
    }
    apply(ctx)
    expect(tabs.registered, 'the native half must stand down').toEqual([])
  })

  it('registers the native type when nothing bridged it', async () => {
    // The other side of the same rule: a native-only deployment has no bridge,
    // so EF must supply the type itself or the panel is unreachable.
    const apply = await loadApply()
    const tabs = makeRegistry()
    const slots = { inject: (_n: string, cb: () => unknown) => cb(), register: () => () => {} }
    const ctx = {
      slots,
      inject: (names: readonly string[], cb: (c: unknown) => unknown) =>
        (names.includes('betterSidebar') ? cb({ get: () => undefined }) : cb({ get: () => tabs })),
    }
    apply(ctx)
    expect(tabs.registered).toEqual(['dsh-epistemic-fold'])
    expect(tabs.get('dsh-epistemic-fold')).toBeDefined()
  })

  it('reconciles either arrival order through the registry subscription', async () => {
    // `ctx.inject` callbacks are asynchronous and the bridge may land before or
    // after EF's own mount. Subscribing is what makes the decision
    // order-independent: whichever arrives second re-runs the reconcile.
    const apply = await loadApply()
    const tabs = makeRegistry() // bridge has NOT run yet
    const slots = { inject: (_n: string, cb: () => unknown) => cb(), register: () => () => {} }
    const ctx = {
      slots,
      inject: (names: readonly string[], cb: (c: unknown) => unknown) =>
        (names.includes('betterSidebar') ? cb({ get: () => undefined }) : cb({ get: () => tabs })),
    }
    apply(ctx)
    expect(tabs.registered, 'no bridge yet, so EF supplies the type').toEqual(['dsh-epistemic-fold'])

    // Now the bridge arrives late and publishes its kind. Registering through
    // the stub notifies subscribers, which is exactly what the real registry
    // does on a registration change — so this also exercises the wake-up path
    // rather than poking the map directly.
    tabs.register({ id: 'dsh-better-sidebar:epistemic-fold:status', kind: 'epistemic-fold:status' })
    expect(tabs.registered, 'the late bridge must retract EF\'s duplicate').toEqual([
      'dsh-better-sidebar:epistemic-fold:status',
    ])
  })
})

describe('RC4-A: the audit findings, pinned so they cannot regress', () => {
  it('A3: a rejected tier is an ERROR result, not a success carrying bad news', async () => {
    // RC4-A found every failure path returning `kind: 'success'`, so a refused
    // switch was indistinguishable from a completed one to the client and to the
    // `command/done` record a log reader sees.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072, plugin: true, systemPrompt: true, commands: true,
      efConfig: { mode: 'legacy' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const agent = { id: 'p', session: Session.create(SessionId(`rc4a-${Date.now()}`)) } as never
    const sig = new AbortController().signal

    const unknown = await harness.ctx.commands.execute(agent, '/context mode turbo', [], sig)
    expect(unknown?.result.kind).toBe('error')

    // Showing the ladder is NOT a failure, so it stays a success.
    const ladder = await harness.ctx.commands.execute(agent, '/context mode', [], sig)
    expect(ladder?.result.kind).toBe('success')
  }, 120_000)

  it('A3: a refused switch is an ERROR, and the engine is unchanged', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072, plugin: true, systemPrompt: true, commands: true,
      efConfig: { mode: 'legacy' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const agent = { id: 'p', session: Session.create(SessionId(`rc4a2-${Date.now()}`)) } as never
    const result = await harness.ctx.commands.execute(
      agent, '/context mode economy', [], new AbortController().signal)
    // On an unpatched build the tier needs the framing seam, so the switch is
    // refused. The refusal must read as a failure.
    if (result?.result.kind === 'error') {
      expect(String(result.result.text)).toContain('cannot switch mode')
      expect(harness.engine.currentMode).toBe('legacy')
    }
  }, 120_000)

  it('A2: the projection carries a CURRENT checkpoint count, distinct from lifetime folds', () => {
    // RC4-A found the panel rendering `folds + roots` under "Checkpoints now".
    // A root rebase collapses the surface, so the two numbers differ.
    const unit = epistemicFoldStatusProjection({ mode: 'economy' })
    let state = unit.init()

    // Three leaf folds: each JOINS the frozen prefix.
    for (let i = 0; i < 3; i += 1) {
      state = reduceStatusEvent(state, {
        type: 'compaction/summary', seq: i, time: 0,
        data: { shadowedTokenCount: 10, summary: [{ type: 'text', text: '[EF1 L cp:x]' }] },
      } as never)
    }
    expect(state.currentCheckpoints).toBe(3)
    expect(state.folds).toBe(3)

    // One root REBASES: the prefix collapses to the single new checkpoint.
    state = reduceStatusEvent(state, {
      type: 'compaction/summary', seq: 9, time: 0,
      data: { shadowedTokenCount: 10, summary: [{ type: 'text', text: '[EF1 R cp:y]' }] },
    } as never)
    expect(state.currentCheckpoints).toBe(1)
    expect(state.roots).toBe(1)
    // The lifetime total kept growing, which is exactly why they must differ.
    expect(state.folds + state.roots).toBe(4)
    expect(unit.wire.view(state).currentCheckpoints).toBe(1)
  })
})
