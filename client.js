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
     * The EF status panel.
     *
     * Reads the projection through the props' own `useProjection`, which the
     * sidebar hands every tab component — so this never needs a Remote call of
     * its own.
     */
    const EpistemicFoldPanel = ({ useProjection, t }) => {
      const status = useProjection(STATUS_KEY)
      // The token meter's OWN pressure unit, read the same way DSH's built-in
      // ContextMeter reads it. Our projection is a pure event fold and cannot
      // carry a meter reading, so the join happens here rather than in the
      // host — the alternative would be a second source of the same fact.
      const pressure = useProjection('contextPressure')
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
              status.costProfileId !== null
                ? jsx.jsx(Row, { label: translate('pricedWith'), value: status.costProfileId, muted: true })
                : null,
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
      providerTokens: 'Provider tokens',
      resumed: 'Resumed',
      modelChanges: 'Model changes',
      observationNote:
        'Observation only — this panel reads a client projection and never enters the model context.',
    }

    /**
     * Register the panel against the sidebar service, if one is mounted.
     *
     * ## Why this is `ctx.inject`, not a declared `inject: [...]`
     *
     * `betterSidebar` belongs to a THIRD-PARTY plugin a deployment may not have.
     * Declaring it in this module's `inject` list makes cordis hold the whole
     * entry in a pending state until the service appears — measured in a real
     * web boot with no `dsh-better-sidebar` installed:
     *
     *   Failed to load plugins
     *   web boot: 1 entry did not activate dsh-epistemic-fold:
     *   pending (waiting for service: betterSidebar)
     *
     * That does not just hide the panel: it fails the WEB BOOT, so an unrelated
     * missing plugin takes the whole UI down. The guarded body below already
     * handled a missing service correctly; the declaration was what broke it.
     *
     * `ctx.inject` is cordis's idiom for exactly this: run the callback only once
     * the service exists, and mount cleanly when it never does. It is the same
     * rule the host half follows for the optional `ctx.tools` / `ctx.commands`.
     */
    function apply(ctx) {
      ctx.inject(['betterSidebar'], (sidebarCtx) => {
        const service = sidebarCtx.get('betterSidebar')
        if (service === undefined) return () => {}
        const dispose = service.registerTab({
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
    }

    return { apply, name: 'epistemic-fold' }
  },
})
