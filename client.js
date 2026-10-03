/**
 * The EF Sidebar panel client face (RC4).
 *
 * ## Why this file is hand-written rather than bundled
 *
 * A DSH client module is a `window.__ModuleLoader__.load({ id, factory })`
 * wrapper whose factory receives a `require`. The real sidebar plugin ships
 * 1.1 MB of that shape produced by a bundler, but the format itself is plain and
 * this panel is small. Adding a bundler to EF would put a browser build pipeline
 * into a project whose directive is explicitly that EF must not grow into a UI
 * system — so the module is authored directly, and `scripts/build-plugin.mjs`
 * copies it verbatim into `lib/`.
 *
 * The only imports are `react` and `react/jsx-runtime`, both provided by the
 * host loader as shared externals. Everything else is plain DOM/CSS.
 *
 * ## What it renders, and from where
 *
 * It reads the `epistemicFold.status` PROJECTION — the same model the command
 * plane's `/context status` renders, reached through the documented
 * `useProjection(key)` hook. It does **not** run the command and parse its text:
 * that would make the panel a reader of a rendering rather than of the facts,
 * and the two could disagree.
 *
 * ## It is an observation plane
 *
 * Nothing here is sent to the model. The panel cannot grow the context it
 * reports on, and it cannot invalidate a prefix cache. That is a property of
 * where the data comes from (a client projection) rather than a promise in a
 * comment.
 *
 * @module dsh-epistemic-fold/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-epistemic-fold',
  factory: (require) => {
    const React = require('react')
    const jsx = require('react/jsx-runtime')

    /** The projection key the host registers (mirrors src/status-projection.ts). */
    const STATUS_KEY = 'epistemicFold.status'

    /** The tab id; `betterSidebar` uses it as `SidebarTab.type`. */
    const TAB_ID = 'epistemic-fold:status'

    /**
     * The native sidebar's implementation id.
     *
     * Distinct from `TAB_ID` on purpose: the native registry documents `id` as
     * "this implementation's identity … unique across every registration (a
     * package name is the natural value)", and it is the key the body and title
     * slots register under. Reusing the better-sidebar id would work today but
     * would collide the moment both sidebars are mounted at once, which is
     * exactly the configuration this adapter exists to support.
     */
    const NATIVE_ID = 'dsh-epistemic-fold'

    /** Format a token count compactly: 47_000 -> "47k". */
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

    /**
     * One labelled figure row.
     *
     * `value` is `null` when the figure is unknown, and renders an em dash —
     * never a zero. An unestablished number and a measured zero mean opposite
     * things, which is the rule the whole status surface is built on.
     */
    const Row = ({ label, value, suffix, muted }) =>
      jsx.jsxs('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', gap: '12px',
          padding: '3px 0', fontSize: '12px',
          opacity: muted === true ? 0.6 : 1,
        },
        children: [
          jsx.jsx('span', { style: { opacity: 0.7 }, children: label }),
          jsx.jsx('span', {
            style: { fontVariantNumeric: 'tabular-nums' },
            children: value === null || value === undefined
              ? '—'
              : `${value}${suffix === undefined ? '' : ` ${suffix}`}`,
          }),
        ],
      })

    /** A section heading. */
    const Section = ({ title, children }) =>
      jsx.jsxs('div', {
        style: { marginTop: '14px' },
        children: [
          jsx.jsx('div', {
            style: {
              fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
              opacity: 0.55, marginBottom: '4px',
            },
            children: title,
          }),
          children,
        ],
      })

    /**
     * Read one projection key for the current session, and keep it live.
     *
     * ## Why this does not rely on a `useProjection` prop
     *
     * EF originally destructured `useProjection` from the tab props, on the stated
     * assumption that "the sidebar hands every tab component" one. It does not.
     * `dsh-better-sidebar` 0.24.1 declares `TabComponentProps` as
     * `{ ctx, store, scope, tab, visible, ... }`, and the string `useProjection`
     * appears nowhere in the package — so the panel threw
     * `useProjection is not a function` inside the sidebar's render boundary and
     * showed an error instead of the status.
     *
     * The prop IS the right idiom for DSH's own docks (`ContextMeter` reads the
     * same `contextPressure` key that way) — but those are mounted by DSH's
     * conversation skeleton, which supplies it. EF's panel is mounted by a
     * third-party sidebar whose tab contract does not.
     *
     * So this reads the projection the way the sidebar itself reads projections
     * (`projectionsBySession[id].values[key]`, the same shape its own subagent
     * catalogs use) and still prefers the prop when a host does provide one.
     *
     * @param ctx - the tab's cordis context (always passed by the sidebar).
     * @param scope - the tab's session scope; `scope.sessionId` names the session.
     * @param useProjectionProp - the optional hook prop, when a host supplies it.
     * @param key - projection key.
     * @returns the value plus the store's state/error, or `undefined` when unknown.
     */
    const useProjectionValue = (ctx, scope, useProjectionProp, key) => {
      // A host that hands the hook owns the subscription; prefer it.
      const propDriven = typeof useProjectionProp === 'function'
      const sessions = ctx === undefined || ctx === null
        ? undefined
        : (typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions)
      const sessionId = scope === undefined || scope === null ? undefined : scope.sessionId

      const read = () => {
        if (sessions === undefined || sessions === null || sessionId === undefined) return undefined
        const list = sessions.list
        if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return undefined
        const per = list.getSnapshot().projectionsBySession
        if (per === undefined || per === null) return undefined
        const entry = per[sessionId]
        if (entry === undefined || entry === null) return undefined
        const values = entry.values
        return {
          value: values === undefined || values === null ? undefined : values[key],
          state: entry.state === undefined ? 'ready' : entry.state,
          error: entry.error === undefined ? null : entry.error,
        }
      }

      const [snapshot, setSnapshot] = React.useState(read)

      React.useEffect(() => {
        if (propDriven) return undefined
        const list = sessions === undefined || sessions === null ? undefined : sessions.list
        if (list === undefined || list === null || typeof list.subscribe !== 'function') return undefined
        // The projection store publishes through the list snapshot, so the
        // list's own subscription is the sidebar's wake-up path.
        const unsubscribe = list.subscribe(() => setSnapshot(read()))
        setSnapshot(read())
        return unsubscribe
      }, [sessions, sessionId, key, propDriven])

      if (propDriven) {
        return { value: useProjectionProp(key), state: 'ready', error: null }
      }
      return snapshot
    }

    /**
     * The EF status panel.
     *
     * Reads the host-computed projection rather than running `/context` and
     * parsing its text: the panel must show the facts, not a rendering of them.
     */
    const EpistemicFoldPanel = ({ useProjection, t, ctx, scope }) => {
      const statusRead = useProjectionValue(ctx, scope, useProjection, STATUS_KEY)
      // The token meter's OWN pressure unit, read the same way DSH's built-in
      // ContextMeter reads it. Our projection is a pure event fold and cannot
      // carry a meter reading, so the join happens here rather than in the
      // host — the alternative would be a second source of the same fact.
      const pressureRead = useProjectionValue(ctx, scope, useProjection, 'contextPressure')
      const status = statusRead === undefined ? undefined : statusRead.value
      const pressure = pressureRead === undefined ? undefined : pressureRead.value
      const translate = typeof t === 'function' ? t : (key) => key

      if (status === undefined || status === null) {
        return jsx.jsx('div', {
          style: { padding: '16px', fontSize: '12px', opacity: 0.7 },
          children: translate('noSession'),
        })
      }

      const cost = status.cost === null
        ? '—'
        : `~${status.cost.toFixed(4)}`
      const modeLabel = status.isTier === true
        ? String(status.mode)
        : `${status.mode} (default)`

      return jsx.jsxs('div', {
        style: { padding: '14px 16px', fontFamily: 'inherit', overflowY: 'auto' },
        children: [
          jsx.jsxs('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: '8px' },
            children: [
              jsx.jsx('div', { style: { fontSize: '13px', fontWeight: 600 }, children: 'Epistemic Fold' }),
              jsx.jsx('div', {
                style: { fontSize: '12px', opacity: 0.75 },
                children: modeLabel,
              }),
            ],
          }),

          pressure !== undefined && pressure !== null
            ? jsx.jsxs(Section, {
              title: translate('currentContext'),
              children: [
                // `projectedTokens` is what the NEXT request would cost; it
                // falls back to `pressureTokens`, the last provider-reported
                // prompt size. Either may be absent before any provider call,
                // in which case the row shows an em dash.
                jsx.jsx(Row, {
                  label: translate('pressure'),
                  value: pressure.projectedTokens !== undefined
                    ? k(pressure.projectedTokens)
                    : (pressure.pressureTokens !== undefined ? k(pressure.pressureTokens) : null),
                  suffix: 'tokens',
                }),
                pressure.contextWindow !== undefined
                  ? jsx.jsx(Row, { label: translate('window'), value: k(pressure.contextWindow), suffix: 'tokens' })
                  : null,
              ],
            })
            : null,

          jsx.jsxs(Section, {
            title: translate('archived'),
            children: [
              // Measured, not estimated: this figure is the meter's own
              // `shadowedTokenCount` summed over the folds, which is a better
              // number than the command plane can produce from bundle text.
              jsx.jsx(Row, { label: translate('archivedTokens'), value: k(status.archivedTokens) }),
              // CURRENT, not lifetime. RC4-A found this row rendering
              // `folds + roots` — a lifetime total — under a label that claims
              // the surface right now, which is the conflation RC2.1 corrected
              // on the command plane.
              jsx.jsx(Row, { label: translate('checkpointsNow'), value: status.currentCheckpoints }),
            ],
          }),

          jsx.jsxs(Section, {
            title: translate('folds'),
            children: [
              jsx.jsx(Row, { label: translate('leafFolds'), value: status.folds }),
              jsx.jsx(Row, { label: translate('rootRebases'), value: status.roots }),
              status.failedCompactions > 0
                ? jsx.jsx(Row, { label: translate('failed'), value: status.failedCompactions })
                : null,
            ],
          }),

          jsx.jsxs(Section, {
            title: translate('retrieval'),
            children: [
              jsx.jsx(Row, { label: translate('recalls'), value: status.recalls }),
              jsx.jsx(Row, { label: translate('searches'), value: status.searches }),
            ],
          }),

          jsx.jsxs(Section, {
            title: translate('session'),
            children: [
              jsx.jsx(Row, { label: translate('cost'), value: cost, muted: status.cost === null }),
              // RC18: name what the figure was priced WITH, and when there is no
              // price list for this route, say that instead of leaving a bare
              // `—`. The old row always showed a profile id because the caller
              // always supplied one — including the synthetic fallback, whose
              // rates are made up. A route with no prices now reports that fact,
              // and names the route it could not price.
              status.costProfileId !== null
                ? jsx.jsx(Row, { label: translate('pricedWith'), value: status.costProfileId, muted: true })
                : (status.usage !== null && status.pricedRoute !== ''
                  ? jsx.jsx(Row, { label: translate('noPrices'), value: status.pricedRoute, muted: true })
                  : null),
              status.usage !== null
                ? jsx.jsx(Row, {
                  label: translate('providerTokens'),
                  value: k(status.usage.uncachedInputTokens + status.usage.cacheReadTokens),
                  muted: true,
                })
                : null,
              status.resumed === true ? jsx.jsx(Row, { label: translate('resumed'), value: 'yes' }) : null,
              status.modelChanges > 0
                ? jsx.jsx(Row, { label: translate('modelChanges'), value: status.modelChanges })
                : null,
            ],
          }),

          jsx.jsx('div', {
            style: { marginTop: '16px', fontSize: '11px', opacity: 0.5, lineHeight: 1.5 },
            children: translate('observationNote'),
          }),
        ],
      })
    }

    /** English strings; a host with a locale binding may override via `t`. */
    const STRINGS = {
      tabTitle: 'Epistemic Fold',
      tabDesc: 'Context runtime status: archived history, folds, recall activity and estimated cost.',
      noSession: 'No active session.',
      currentContext: 'Current context',
      pressure: 'Pressure',
      window: 'Window',
      archived: 'Archived history',
      archivedTokens: 'Archived tokens',
      checkpointsNow: 'Checkpoints now',
      folds: 'Folds (lifetime)',
      leafFolds: 'Leaf folds',
      rootRebases: 'Root rebases',
      failed: 'Failed folds',
      retrieval: 'Retrieval',
      recalls: 'Recalls',
      searches: 'Searches',
      session: 'Session',
      cost: 'Cost (estimated)',
      pricedWith: 'Priced with',
      noPrices: 'No prices for',
      providerTokens: 'Provider tokens',
      resumed: 'Resumed',
      modelChanges: 'Model changes',
      observationNote:
        'Observation only — this panel reads a client projection and never enters the model context.',
    }

    /**
     * Register the panel against whichever sidebar is mounted.
     *
     * ## The two sidebars, and why BOTH registrations are needed
     *
     * DSH ships a native right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`)
     * and `dsh-better-sidebar` is a third-party REPLACEMENT built on top of it.
     * They keep SEPARATE tab registries:
     *
     *   native          `ctx.sidebarRightTabs.register(definition)` plus a body
     *                   registered into the `sidebar.right.pane.tab` slot
     *   better-sidebar  `ctx.betterSidebar.registerTab({ id, title, component })`
     *
     * `dsh-better-sidebar` runs a `registerNativeSurface` bridge, which is easy to
     * mistake for a one-way compatibility layer. It is the opposite direction: it
     * pushes BETTER-sidebar's own tabs INTO the native registry (so DSH's native
     * surface can show them), and its UI renders from its own `tabs` Map. Nothing
     * copies native registrations back into better-sidebar.
     *
     * So a panel that registers only natively is invisible in better-sidebar, and a
     * panel that registers only with better-sidebar is invisible on a native-only
     * deployment. EF registers with BOTH, and each is guarded independently: a
     * deployment with neither sidebar must still boot.
     *
     * ## Why these are `ctx.inject`, not a declared `inject: [...]`
     *
     * Both services belong to plugins a deployment may not have. Declaring either
     * in this module's `inject` list makes cordis hold the whole entry pending
     * until the service appears — measured in a real web boot with no
     * `dsh-better-sidebar` installed:
     *
     *   Failed to load plugins
     *   web boot: 1 entry did not activate dsh-epistemic-fold:
     *   pending (waiting for service: betterSidebar)
     *
     * That does not just hide the panel: it fails the WEB BOOT, so an unrelated
     * missing plugin takes the whole UI down. `ctx.inject` is cordis's idiom for
     * exactly this: run the callback once the service exists, and mount cleanly
     * when it never does.
     */
    function apply(ctx) {
      const disposeBetter = applyBetterSidebar(ctx)
      const disposeNative = applyNativeSidebar(ctx)
      return () => {
        disposeBetter()
        disposeNative()
      }
    }

    /** better-sidebar's registration, when that plugin is mounted. */
    function applyBetterSidebar(ctx) {
      let dispose
      ctx.inject(['betterSidebar'], (sidebarCtx) => {
        const service = sidebarCtx.get('betterSidebar')
        if (service === undefined) return () => {}
        dispose = service.registerTab({
          id: TAB_ID,
          title: () => STRINGS.tabTitle,
          description: () => STRINGS.tabDesc,
          order: 60,
          single: true,
          component: (props) => jsx.jsx(EpistemicFoldPanel, {
            ...props,
            t: (key) => STRINGS[key] ?? key,
          }),
        })
        // cordis auto-invokes a returned disposer on fiber disposal (HMR-safe).
        return dispose
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }

    /**
     * The native right sidebar's registration — as a FALLBACK, not always.
     *
     * Two-stage, as the native contract requires: the TYPE goes into
     * `sidebarRightTabs`, and the BODY into the `sidebar.right.pane.tab` slot
     * keyed by the same id. A type with no body renders an empty pane.
     *
     * The body is a closure over `ctx` because the native body props carry only
     * `{ hooks: { tabInfo } }` — no `ctx`, no `store`. That is the same technique
     * `dsh-better-sidebar` uses for its own native bodies, and it is why the
     * projection read cannot live in the props here.
     *
     * ## Why this is conditional (RC17)
     *
     * `dsh-better-sidebar` is a REPLACEMENT for the native sidebar that ALSO
     * bridges its own tabs INTO the native registry, so DSH's own surface can
     * show them. It does that unconditionally, for every registered descriptor,
     * and it contributes a guide entry alongside each one.
     *
     * EF registers with better-sidebar under `epistemic-fold:status`, so that
     * bridge already puts a native type of kind `epistemic-fold:status` — with a
     * guide entry titled "Epistemic Fold" — into the registry. EF registering its
     * OWN native type (`dsh-epistemic-fold`) on top produced TWO guide entries
     * with the same title, the same icon and the same behaviour: measured in a
     * real browser, indistinguishable to a user, and picking either opened a
     * separate tab. The two kinds differ, so the registry's own duplicate guard
     * never fired.
     *
     * So this half is now a fallback: it exists exactly when better-sidebar's
     * bridge does not. The signal is read off the REGISTRY rather than from
     * service presence, because the bridge is what creates the duplicate — a
     * mounted better-sidebar whose bridge has not run, or failed, must still
     * leave a working entry. `tabs.get(TAB_ID)` names a kind only that bridge can
     * register, since `TAB_ID` is EF's own descriptor id.
     *
     * `subscribe` makes the decision order-independent: `ctx.inject` callbacks
     * are asynchronous and either registration may land first, so whichever
     * arrives second re-runs the reconcile through the registry change.
     */
    function applyNativeSidebar(ctx) {
      let teardown = null
      // Wait for the tab registry only. `slots` is not named here because the
      // module declares it in its own `inject` (see the export at the bottom):
      // this callback reads `ctx.slots` off the plugin's own context, and that
      // access resolves only because the module-level inject put it there.
      const mount = (injected) => {
        const tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined) return () => {}

        // Everything this half owns, so one reconcile can add or drop it whole.
        let disposeType = null
        let disposeBody = null

        const release = () => {
          for (const dispose of [disposeBody, disposeType]) {
            if (typeof dispose !== 'function') continue
            try {
              dispose()
            } catch {
              // A disposal that throws must not strand the other.
            }
          }
          disposeBody = null
          disposeType = null
        }

        // REENTRANCY GUARD, and it is load-bearing rather than defensive.
        //
        // `tabs.register` synchronously notifies subscribers: the registry calls
        // its own `refresh()` inside the registering `ctx.effect`, and `refresh`
        // publishes to every listener. So without this flag the sequence is
        //
        //   reconcile -> register -> notify -> reconcile -> register -> …
        //
        // which is an unbounded recursion, not a missed update. Measured as
        // `RangeError: Maximum call stack size exceeded` from the first
        // registration. The flag is safe because a registration made BY this
        // function cannot change the answer to the question it asks: the only
        // thing that flips the decision is `TAB_ID` appearing, and that comes
        // from the bridge, not from here.
        let reconciling = false

        const reconcile = () => {
          if (reconciling) return
          reconciling = true
          try {
            reconcileOnce()
          } finally {
            reconciling = false
          }
        }

        const reconcileOnce = () => {
          const bridged = typeof tabs.get === 'function' ? tabs.get(TAB_ID) : undefined
          if (bridged !== undefined) {
            // better-sidebar already put this panel in the native registry, guide
            // entry included. A second one is the duplicate this exists to avoid.
            release()
            return
          }
          if (disposeType !== null) return

          // Stage one: what this type IS. `priority: 'extension'` is the band for
          // a type from outside the product, and `title` is the chip text captured
          // at open time (the slot below can override it live, but a title here
          // means the chip is correct even before the body mounts).
          disposeType = tabs.register({
            id: NATIVE_ID,
            kind: NATIVE_ID,
            priority: 'extension',
            title: () => STRINGS.tabTitle,
            // `description` is THUNKED copy, like `title` beside it: the guide
            // calls it as `entry.description?.()` on every render so a language
            // change needs no re-registration. Passing the string itself throws
            // `STRINGS.tabDesc is not a function`, and because the guide page is
            // the doorway to this type, the throw takes out the whole guide body
            // — the entry never appears and the tab cannot be opened at all.
            guide: [{ id: NATIVE_ID, order: 60, title: () => STRINGS.tabTitle, description: () => STRINGS.tabDesc }],
          })

          // Stage two: the body. `ctx.slots.inject` binds the contribution to
          // this plugin's fiber, so it lives exactly as long as the plugin does.
          disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: NATIVE_ID,
            inject: (sessionId) => ({ sessionId, efCtx: ctx }),
          }, NativePanelBody))
        }

        const unsubscribe = typeof tabs.subscribe === 'function' ? tabs.subscribe(reconcile) : () => {}
        reconcile()

        // Idempotent: cordis invokes the returned disposer on fiber disposal AND
        // the caller's own disposer runs, so this is reachable twice.
        let released = false
        teardown = () => {
          if (released) return
          released = true
          unsubscribe()
          release()
        }
        return teardown
      }
      // `sidebarRightTabs` is the native registry; `slots` is the slot registry.
      ctx.inject(['sidebarRightTabs'], mount)
      return () => {
        if (typeof teardown === 'function') teardown()
      }
    }

    /**
     * The native tab body.
     *
     * Receives the slot's injected props (`sessionId` plus the closed-over context)
     * and renders the SAME panel better-sidebar renders — one component, so the two
     * sidebars cannot drift apart in what they report.
     */
    const NativePanelBody = (props) => jsx.jsx(EpistemicFoldPanel, {
      ctx: props.efCtx,
      scope: { sessionId: props.sessionId },
      t: (key) => STRINGS[key] ?? key,
    })

    // `slots` is a REQUIRED cordis service for this module, and it has to be
    // declared here rather than reached for lazily.
    //
    // The native sidebar's body seat is `ctx.slots.inject(...)`, and cordis
    // refuses that property outright when the service is not in the fiber's
    // inject list:
    //
    //   cannot get property "slots" without inject
    //
    // The failure is shaped to look like something else. The TYPE registration
    // above runs first and succeeds, so the chip appears and the tab opens —
    // then the body seat throws, the renderer's boundary catches it, and the
    // pane reads "这类内容还没有可用的查看方式。" (no available way to view this
    // content). A registered type with a missing body is a legitimate state
    // (the owning plugin was unmounted), so the UI reports it as one and the
    // real cause never surfaces.
    //
    // Declaring it is safe because it cannot be absent in a web deployment: the
    // slot registry is provided by `@deepseek-ai/dsh-client-ui-renderer`, which
    // is the shell that mounts this module at all. `dsh-better-sidebar` declares
    // the same service the same way.
    return { apply, name: 'epistemic-fold', inject: ['slots'] }
  },
})
