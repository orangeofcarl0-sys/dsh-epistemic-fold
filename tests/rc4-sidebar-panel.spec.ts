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
    const unit = epistemicFoldStatusProjection({ mode: 'economy', profile })
    const state = {
      ...unit.init(),
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
      profile: parseEconomicsProfile({
        id: 'p', provider: 'test', modelPattern: '*', asOf: '2026-09-30',
        pricing: { inputMissPerM: 1, inputHitPerM: 0, outputPerM: 1 },
        cache: { mode: 'automatic', bestEffort: true },
        context: { windowTokens: 1_000 },
      }),
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
    // The tab registers through the sidebar service, so the client must wait
    // for it rather than assuming it.
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
    expect(captured?.mod['inject']).toEqual(['betterSidebar'])
    expect(typeof captured?.mod['apply']).toBe('function')

    // Driving apply() against a fake service registers ONE tab with a stable id.
    let tab: { id: string; single?: boolean; title: () => string } | undefined
    const ctx = {
      get: (key: string) => (key === 'betterSidebar'
        ? { registerTab: (descriptor: typeof tab) => { tab = descriptor; return () => { tab = undefined } } }
        : undefined),
    }
    const apply = captured?.mod['apply'] as (c: unknown) => unknown
    const dispose = apply(ctx)
    expect(tab?.id).toBe('epistemic-fold:status')
    expect(tab?.single).toBe(true)
    expect(tab?.title()).toBe('Epistemic Fold')
    expect(typeof dispose).toBe('function')
  })

  it('does nothing when no sidebar service is mounted', async () => {
    // A deployment without the sidebar must still load the client face rather
    // than fail — the same conditional rule the host follows for `ctx.tools`.
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
    expect(() => apply({ get: () => undefined })).not.toThrow()
  })
})
