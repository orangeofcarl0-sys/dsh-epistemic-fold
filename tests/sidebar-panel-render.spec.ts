/**
 * The panel must RENDER under the props the real sidebar passes.
 *
 * ## The defect this exists to catch
 *
 * EF's panel destructured `useProjection` from its tab props and called it,
 * with a comment asserting "the sidebar hands every tab component" one. It does
 * not. `dsh-better-sidebar` 0.24.1 declares
 *
 *     interface TabComponentProps { ctx, store, scope, tab, visible, ... }
 *
 * and the string `useProjection` appears nowhere in the package. Selecting the
 * EF tab therefore threw `useProjection is not a function` inside the sidebar's
 * render boundary, and the panel showed an error instead of the status.
 *
 * ## Why the existing tests passed anyway
 *
 * `rc4-sidebar-panel.spec.ts` drives `apply()` against a fake service and then
 * asserts the descriptor's `id`, `single` and `title()`. Its captured-descriptor
 * type is
 *
 *     { id: string; single?: boolean; title: () => string }
 *
 * — `component` is not in that type at all, and nothing anywhere in `tests/`
 * calls `.component(...)`. Registration was verified; rendering never was.
 *
 * RC4's report called this "It renders, and unknown is `—`", but the renderer it
 * refers to invoked the component DIRECTLY with hand-made props. Rendering a
 * component with the props you chose proves it works with those props; it does
 * not prove the host supplies them. That gap is the whole defect.
 *
 * ## What these tests do differently
 *
 * They build the props from the sidebar's OWN `TabComponentProps` contract — the
 * fields a real tab receives — and assert the render survives. The prop set is
 * declared here as a literal so that a change to the sidebar's contract shows up
 * as a failing expectation rather than as a panel that breaks in the browser.
 *
 * @module tests/sidebar-panel-render
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** The EF projection key the panel reads. Mirrors src/status-projection.ts. */
const STATUS_KEY = 'epistemicFold.status'

interface PanelNode {
  readonly t: unknown
  readonly p: { readonly children?: unknown; readonly style?: Record<string, unknown> }
}

/** A minimal React stand-in: `useState`/`useEffect` enough for one render. */
function reactStub(): Record<string, unknown> {
  return {
    createElement: (t: unknown, p: unknown) => ({ t, p }),
    useState: (initial: unknown) => {
      // The real hook seeds from the initializer on FIRST render, which is the
      // render under test. Effects are not replayed, so the panel must produce
      // its content from this value alone — a panel that renders empty until an
      // effect fires would show a blank frame in the browser.
      const value = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useEffect: () => {},
  }
}

const jsxRuntime = {
  jsx: (t: unknown, p: unknown) => ({ t, p }),
  jsxs: (t: unknown, p: unknown) => ({ t, p }),
  Fragment: 'F',
}

/** Evaluate client.js the way the browser module loader does, and capture it. */
function loadClientModule(): { apply: (ctx: unknown) => unknown } {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  let captured: Record<string, unknown> | undefined
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: {
      load: ({ factory }: { factory: (r: (n: string) => unknown) => Record<string, unknown> }) => {
        captured = factory(name => {
          if (name === 'react') return reactStub()
          if (name === 'react/jsx-runtime') return jsxRuntime
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
  }
  if (captured === undefined) throw new Error('client.js did not register a module')
  return captured as { apply: (ctx: unknown) => unknown }
}

/**
 * Capture BOTH registrations the module makes.
 *
 * EF registers with the native right sidebar and with `dsh-better-sidebar`, which
 * keep separate tab registries — see `apply` in client.js. A helper that captured
 * only one would hide a regression in the other.
 */
function registrations(): {
  readonly betterTab: Record<string, unknown>
  readonly nativeType: Record<string, unknown>
  readonly nativeBody: (props: unknown) => unknown
} {
  const mod = loadClientModule()
  let betterTab: Record<string, unknown> | undefined
  let nativeType: Record<string, unknown> | undefined
  let nativeBody: ((props: unknown) => unknown) | undefined
  const betterService = {
    registerTab: (descriptor: Record<string, unknown>) => {
      betterTab = descriptor
      return () => {}
    },
  }
  const nativeTabs = {
    register: (definition: Record<string, unknown>) => {
      nativeType = definition
      return () => {}
    },
  }
  const slots = {
    inject: (_name: string, cb: () => unknown) => cb(),
    register: (_def: unknown, component: (props: unknown) => unknown) => {
      nativeBody = component
      return () => {}
    },
  }
  const ctx = {
    slots,
    inject: (names: readonly string[], cb: (c: unknown) => unknown) => {
      if (names.includes('betterSidebar')) return cb({ get: () => betterService })
      return cb({ get: () => nativeTabs })
    },
  }
  mod.apply(ctx)
  if (betterTab === undefined) throw new Error('no better-sidebar tab was registered')
  if (nativeType === undefined) throw new Error('no native tab type was registered')
  if (nativeBody === undefined) throw new Error('no native tab body was registered')
  return { betterTab, nativeType, nativeBody }
}

/** Capture the better-sidebar tab descriptor (the common case in these tests). */
function registeredTab(): Record<string, unknown> {
  return registrations().betterTab
}

/**
 * The props a real sidebar tab receives.
 *
 * This is `TabComponentProps` from `dsh-better-sidebar` 0.24.1, minus the
 * optional callbacks the panel does not use. Deliberately WITHOUT
 * `useProjection`: that absence is the contract being pinned.
 */
function realTabProps(overrides: { readonly projections?: Record<string, unknown> } = {}): Record<string, unknown> {
  const sessionId = 'session-test-1'
  const values: Record<string, unknown> = overrides.projections ?? {}
  return {
    ctx: {
      get: (name: string) =>
        name === 'sessions'
          ? {
            list: {
              getSnapshot: () => ({
                projectionsBySession: {
                  [sessionId]: { values, state: 'ready', error: null },
                },
              }),
              subscribe: () => () => {},
            },
          }
          : undefined,
    },
    store: { getSnapshot: () => ({ sessionId }), subscribe: () => () => {}, getPrefs: () => ({}) },
    scope: { sessionId },
    tab: { id: 'epistemic-fold:status', type: 'epistemic-fold:status', title: 'Epistemic Fold' },
    visible: true,
  }
}

/**
 * The panel's text, flattened from the rendered node tree.
 *
 * Function elements are rendered rather than skipped: the registered
 * `component` is a WRAPPER (`props => jsx(EpistemicFoldPanel, props)`), so its
 * text only exists once the element it returns is invoked, and `Section`/`Row`
 * are local components whose text lives in what they return.
 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'function') return ''
  const asNode = node as PanelNode
  if (typeof asNode.t === 'function') {
    return textOf((asNode.t as (props: unknown) => unknown)(asNode.p))
  }
  if (asNode.p !== undefined) return textOf(asNode.p.children)
  return ''
}

/** Render the registered tab component with the given props, and read its text. */
function renderPanel(overrides: Parameters<typeof realTabProps>[0] = {}): string {
  const tab = registeredTab()
  const component = tab['component'] as (props: unknown) => unknown
  return textOf(component(realTabProps(overrides)))
}

/**
 * A complete `FoldStatusView`, as the host projection produces it.
 *
 * Deliberately COMPLETE rather than minimal: the panel branches on
 * `usage !== null` and then reads four fields, so a fixture that omits `usage`
 * makes the panel throw for a reason that has nothing to do with the contract
 * under test. A realistic fixture keeps a failure meaningful.
 */
function statusView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'economy',
    isTier: true,
    archivedTokens: 0,
    folds: 0,
    roots: 0,
    currentCheckpoints: 0,
    recalls: 0,
    searches: 0,
    resumed: false,
    modelChanges: 0,
    failedCompactions: 0,
    cost: null,
    costProfileId: null,
    pricedRoute: '',
    usage: null,
    ...overrides,
  }
}

describe('the sidebar panel renders under the REAL tab props', () => {
  it('renders without throwing when no useProjection prop is supplied', () => {
    const tab = registeredTab()
    const component = tab['component'] as (props: unknown) => unknown
    expect(typeof component).toBe('function')

    // The real sidebar passes ctx/store/scope/tab/visible and NO useProjection.
    // This call is the test the previous suite never made.
    const props = realTabProps({ projections: { [STATUS_KEY]: statusView() } })
    expect(() => component(props)).not.toThrow()
  })

  it('renders the status values, not an error, when the projection is present', () => {
    const text = renderPanel({
      projections: {
        [STATUS_KEY]: statusView({ mode: 'economy', isTier: true, cost: null }),
        contextPressure: { projectedTokens: 47_000, contextWindow: 1_000_000 },
      },
    })
    // The mode the engine reported must reach the panel.
    expect(text).toContain('economy')
    // And the figures read through the same path.
    expect(text).toContain('47k')
    // An unpriced cost is an em dash, never a zero — the rule the whole status
    // surface is built on.
    expect(text).toContain('—')
  })

  it('renders the no-session state when the projection is absent', () => {
    const text = renderPanel()
    // Absent must render the placeholder, not throw and not fabricate a zero.
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('NaN')
  })

  it('still uses a useProjection prop when a host provides one', () => {
    // The prop is the cheaper subscription and the idiom DSH's own docks use, so
    // a host that offers it must be honoured rather than ignored.
    const tab = registeredTab()
    const component = tab['component'] as (props: unknown) => unknown
    const seen: string[] = []
    const props = {
      ...realTabProps(),
      useProjection: (key: string) => {
        seen.push(key)
        return key === STATUS_KEY ? statusView({ mode: 'quality', isTier: true }) : undefined
      },
    }
    const text = textOf(component(props))
    expect(seen).toContain(STATUS_KEY)
    expect(text).toContain('quality')
  })

  it('the sidebar contract really has no useProjection, so this stays necessary', () => {
    // Pins the reason the fallback exists. If a future sidebar adds the prop,
    // this test failing is the signal to revisit — not a reason to delete it.
    const sidebar = join(
      process.env.DSH_HOME ?? 'D:/dsh',
      'profiles', 'ef-web', 'node_modules', 'dsh-better-sidebar', 'lib', 'client.js',
    )
    let source: string
    try {
      source = readFileSync(sidebar, 'utf8')
    } catch {
      return // no installed sidebar on this machine: nothing to pin
    }
    expect(source.includes('useProjection')).toBe(false)
    // But the ctx path the panel now uses IS the sidebar's own:
    expect(source.includes('projectionsBySession')).toBe(true)
  })
})

/**
 * The native right sidebar.
 *
 * DSH ships `@deepseek-ai/dsh-client-ui-sidebar-right`, and `dsh-better-sidebar`
 * is a third-party replacement built on top of it — but they keep SEPARATE tab
 * registries, and better-sidebar's `registerNativeSurface` bridge runs the other
 * way (it pushes better-sidebar's tabs into the native registry, not the
 * reverse). So a panel registered only natively is invisible in better-sidebar,
 * and one registered only with better-sidebar is invisible on a native-only
 * deployment. EF registers with both; these tests pin the native half.
 */
describe('the panel also registers with the NATIVE right sidebar', () => {
  it('registers a tab TYPE with the native registry', () => {
    const { nativeType } = registrations()
    expect(nativeType['id']).toBe('dsh-epistemic-fold')
    expect(nativeType['kind']).toBe('dsh-epistemic-fold')
    // A type from outside the product: the band the native registry documents for
    // extensions, and the one that outranks the shipped viewers.
    expect(nativeType['priority']).toBe('extension')
    expect(typeof nativeType['title']).toBe('function')
    expect((nativeType['title'] as () => string)()).toBe('Epistemic Fold')
  })

  it('registers a BODY into the pane.tab slot, keyed by the same id', () => {
    // The native contract is two-stage: the type alone renders an empty pane.
    // A type with no body is the failure this assertion exists to catch.
    const { nativeType, nativeBody } = registrations()
    expect(typeof nativeBody).toBe('function')
    expect(nativeType['id']).toBe('dsh-epistemic-fold')
  })

  it('renders the SAME panel as better-sidebar, from the closed-over context', () => {
    // The native body props carry only `{ sessionId, efCtx }` — the slot injects
    // them, and `efCtx` is the closure the registration captured. There is no
    // `useProjection` and no `store` here either, which is why the projection is
    // read through ctx on both paths.
    const { nativeBody } = registrations()
    const sessionId = 'session-native-1'
    const text = textOf(nativeBody({
      sessionId,
      efCtx: {
        get: (name: string) =>
          name === 'sessions'
            ? {
              list: {
                getSnapshot: () => ({
                  projectionsBySession: {
                    [sessionId]: {
                      values: {
                        [STATUS_KEY]: statusView({ mode: 'balanced', isTier: true }),
                        contextPressure: { projectedTokens: 12_000, contextWindow: 500_000 },
                      },
                      state: 'ready',
                      error: null,
                    },
                  },
                }),
                subscribe: () => () => {},
              },
            }
            : undefined,
      },
    }))
    // One component, so the two sidebars cannot report different things.
    expect(text).toContain('balanced')
    expect(text).toContain('12k')
  })

  it('renders the no-session state when the native session has no projection', () => {
    const { nativeBody } = registrations()
    const text = textOf(nativeBody({
      sessionId: 'session-native-empty',
      efCtx: { get: () => undefined },
    }))
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('NaN')
  })

  it('a deployment with NEITHER sidebar still boots', () => {
    // Both registrations are `ctx.inject` callbacks precisely so a missing
    // service cannot hold the entry pending — which was measured to fail the
    // whole web boot, not merely hide the panel.
    const mod = loadClientModule()
    const ctx = { slots: {}, inject: () => {} }
    expect(() => mod.apply(ctx)).not.toThrow()
  })
})

describe('RC19: the panel is readable at a glance', () => {
  /** A usage block with a known cache-hit share. */
  const usageOf = (uncached: number, cacheRead: number, output = 0) => ({
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
  })

  it('reads millions as millions, not as four-digit thousands', () => {
    // `1049k` and `7258k` are what the old formatter produced for a 1,049,000
    // window and a 7,258,000 total. The trailing digits carry no information a
    // reader can act on, and four-digit groups are measurably slower to compare
    // than `1.0M` against `7.3M`.
    const text = renderPanel({
      projections: {
        [STATUS_KEY]: statusView({
          archivedTokens: 133_254,
          usage: usageOf(1_258_000, 6_000_000, 40_000),
        }),
      },
    })
    expect(text).toContain('1.3M') // uncached input
    expect(text).toContain('6.0M') // cache reads
    expect(text).not.toContain('7258k')
    expect(text).not.toContain('1049k')
    // Below 10k the decimal distinguishes magnitudes; above it, it is noise.
    // 133,254 sits in the `k` band and keeps one: `133k`.
    expect(text).toContain('133k')
  })

  it('shows the cache-hit share, which is what the whole design is for', () => {
    // The panel reported one lumped `Provider tokens` row, which cannot show
    // cache reuse — the single figure EF's argument turns on. 6,000,000 reads
    // of a 7,258,000-token prompt side is 82.7%.
    const text = renderPanel({
      projections: {
        [STATUS_KEY]: statusView({ usage: usageOf(1_258_000, 6_000_000, 40_000) }),
      },
    })
    expect(text).toContain('82.7%')
    // The split is shown, not just the share — a share alone cannot be checked.
    expect(text).toContain('1.3M')
    expect(text).toContain('6.0M')
  })

  it('reports the cache-hit share as UNKNOWN when there is no prompt side', () => {
    // A session with only output tokens has no prompt to have been cached, and
    // `0 / 0` must not be printed as `0%` — that would read as "caching is
    // broken" rather than "there is nothing to cache yet".
    const text = renderPanel({
      projections: {
        [STATUS_KEY]: statusView({ usage: usageOf(0, 0, 500) }),
      },
    })
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('0%')
  })

  it('shows how full the context is, so the pressure figure has a reference', () => {
    // `Pressure 68k / Window 1049k` is two numbers that must be divided before
    // they mean anything. 65,536 / 1,048,576 = 6.3%.
    const text = renderPanel({
      projections: {
        [STATUS_KEY]: statusView(),
        contextPressure: { projectedTokens: 65_536, contextWindow: 1_048_576 },
      },
    })
    expect(text).toContain('6.3%')
  })

  it('speaks the host\'s language when the locale service says so', () => {
    // The panel was English-only while the host UI followed the user's locale
    // preference, so a `zh` deployment showed a Chinese harness with an English
    // panel. `zh-CN` and friends must match on the primary subtag.
    const zhProps = realTabProps({ projections: { [STATUS_KEY]: statusView() } })
    ;(zhProps['ctx'] as { get: (n: string) => unknown }).get = (name: string) => {
      if (name === 'locale') return { getSnapshot: () => ({ active: 'zh-CN' }) }
      if (name === 'sessions') {
        return {
          list: {
            getSnapshot: () => ({
              projectionsBySession: {
                'session-test-1': { values: { [STATUS_KEY]: statusView() }, state: 'ready', error: null },
              },
            }),
            subscribe: () => () => {},
          },
        }
      }
      return undefined
    }
    const component = registeredTab()['component'] as (props: unknown) => unknown
    const text = textOf(component(zhProps))
    expect(text).toContain('当前上下文')
    expect(text).toContain('归档历史')
    expect(text).not.toContain('Current context')
  })

  it('falls back to English when no locale service is mounted', () => {
    // `realTabProps`'s `ctx.get` answers only `sessions`, so this is the
    // no-locale deployment: it must render English rather than throw or show
    // raw keys.
    const text = renderPanel({ projections: { [STATUS_KEY]: statusView() } })
    expect(text).toContain('Current context')
    expect(text).not.toContain('currentContext')
  })
})
