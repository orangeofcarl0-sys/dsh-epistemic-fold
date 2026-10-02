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

/** Capture the tab descriptor the module registers. */
function registeredTab(): Record<string, unknown> {
  const mod = loadClientModule()
  let tab: Record<string, unknown> | undefined
  const service = {
    registerTab: (descriptor: Record<string, unknown>) => {
      tab = descriptor
      return () => {}
    },
  }
  const ctx = { inject: (_names: readonly string[], cb: (c: unknown) => unknown) => cb({ get: () => service }) }
  mod.apply(ctx)
  if (tab === undefined) throw new Error('no tab was registered')
  return tab
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
