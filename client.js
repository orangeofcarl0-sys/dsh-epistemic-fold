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

    /**
     * Format a token count compactly, in the unit a reader thinks in.
     *
     * The old rule capped at `k`, so a 1_049_000-token window printed `1049k`
     * and a 7_258_000-token total printed `7258k` — four digits of which the
     * last three carry no decision-relevant information. Millions now read as
     * millions. Below 10k the decimal is kept, because there it distinguishes
     * real magnitudes.
     */
    const k = (n) => {
      if (!Number.isFinite(n)) return '—'
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
      return String(n)
    }

    /** The exact figure, for a row's tooltip: 1049000 -> "1,049,000". */
    const exact = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—')

    /**
     * One labelled figure row.
     *
     * `value` is `null` when the figure is unknown, and renders an em dash —
     * never a zero. An unestablished number and a measured zero mean opposite
     * things, which is the rule the whole status surface is built on.
     *
     * `raw` is the unrounded figure behind a compact `value`, exposed as the
     * element's `title` so the exact number stays reachable without a second
     * row spending width on it.
     */
    const Row = ({ label, value, suffix, muted, raw, hint }) =>
      jsx.jsxs('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', gap: '12px',
          padding: '3px 0', fontSize: '12px',
          opacity: muted === true ? 0.6 : 1,
        },
        children: [
          jsx.jsx('span', {
            style: { opacity: 0.7 },
            title: hint === undefined ? undefined : hint,
            children: label,
          }),
          jsx.jsx('span', {
            style: { fontVariantNumeric: 'tabular-nums' },
            title: raw === undefined ? undefined : exact(raw),
            children: value === null || value === undefined
              ? '—'
              : `${value}${suffix === undefined ? '' : ` ${suffix}`}`,
          }),
        ],
      })

    /**
     * A proportion bar: how full the context is, at a glance.
     *
     * This is the one figure the panel was missing that changes what a reader
     * DOES. `Pressure 68k / Window 1049k` is two numbers that must be divided
     * before they mean anything; EF folds well before the window is full, so
     * the interesting question is "how close am I to a fold", not "how big is
     * the window". The bar answers it without arithmetic.
     *
     * `ratio` is clamped for display only — the percentage text beside it is
     * the real value, so a context that somehow exceeds its window reads as
     * over 100% rather than silently pinning at full.
     */
    const Bar = ({ ratio, label }) => {
      const pct = Number.isFinite(ratio) ? Math.max(0, ratio * 100) : null
      const filled = pct === null ? 0 : Math.min(100, pct)
      return jsx.jsxs('div', {
        style: { marginTop: '6px' },
        children: [
          // Track and fill are SIBLINGS, not nested: `opacity` cascades to
          // children, so a dimmed track would dim the fill with it and the bar
          // would read as uniformly faint. Both inherit `currentColor`, so the
          // bar follows the theme rather than hard-coding one.
          jsx.jsxs('div', {
            style: { position: 'relative', height: '4px', borderRadius: '2px' },
            children: [
              jsx.jsx('div', {
                style: {
                  position: 'absolute', inset: '0', borderRadius: '2px',
                  backgroundColor: 'currentColor', opacity: 0.18,
                },
              }),
              jsx.jsx('div', {
                style: {
                  position: 'absolute', top: '0', bottom: '0', left: '0',
                  width: `${filled}%`, borderRadius: '2px',
                  backgroundColor: 'currentColor',
                  transition: 'width 200ms ease-out',
                },
              }),
            ],
          }),
          label === undefined
            ? null
            : jsx.jsx('div', {
              style: { marginTop: '4px', fontSize: '11px', opacity: 0.6 },
              children: label,
            }),
        ],
      })
    }

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
      // The translator is built from the TAB's own context, not the one this
      // module registered with. The registration ctx is the plugin's fiber and
      // does NOT resolve `locale`; the tab ctx is the one the sidebar hands
      // down and the one that can. A host that supplies its own `t` still wins.
      const translate = typeof t === 'function' ? t : translatorFor(ctx)

      if (status === undefined || status === null) {
        return jsx.jsx('div', {
          style: { padding: '16px', fontSize: '12px', opacity: 0.7 },
          children: translate('noSession'),
        })
      }

      const cost = status.cost === null ? '—' : `~${status.cost.toFixed(4)}`
      const modeLabel = status.isTier === true
        ? String(status.mode)
        : `${status.mode} (default)`

      // `projectedTokens` is what the NEXT request would cost; it falls back to
      // `pressureTokens`, the last provider-reported prompt size. Either may be
      // absent before any provider call, in which case the row shows an em dash.
      const pressureTokens = pressure === undefined || pressure === null
        ? undefined
        : (pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens)
      const windowTokens = pressure === undefined || pressure === null ? undefined : pressure.contextWindow

      // How full the context is. This is the figure the panel was missing: EF
      // folds well before the window is full, so `Pressure 68k / Window 1049k`
      // is two numbers that must be divided before they mean anything.
      const occupancy = pressureTokens !== undefined && windowTokens !== undefined && windowTokens > 0
        ? pressureTokens / windowTokens
        : undefined

      // Cache reuse, from the provider's own cumulative split. This is the
      // number EF's whole argument turns on — the savings come from the frozen
      // prefix staying cached — and the panel previously reported only a single
      // lumped "Provider tokens", which cannot show it.
      //
      // Denominator is the PROMPT side (uncached + cache reads), matching DSH's
      // own `formatCacheHitPercent(cacheRead, total - output)` rather than
      // inventing a second convention for the same quantity.
      const usage = status.usage
      const promptTokens = usage === null ? undefined : usage.uncachedInputTokens + usage.cacheReadTokens
      const cacheHit = promptTokens === undefined || promptTokens === 0
        ? undefined
        : usage.cacheReadTokens / promptTokens

      return jsx.jsxs('div', {
        style: { padding: '14px 16px', fontFamily: 'inherit', overflowY: 'auto' },
        children: [
          jsx.jsxs('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
            children: [
              jsx.jsx('div', { style: { fontSize: '13px', fontWeight: 600 }, children: translate('tabTitle') }),
              jsx.jsx('div', { style: { fontSize: '12px', opacity: 0.75 }, children: modeLabel }),
            ],
          }),

          jsx.jsxs(Section, {
            title: translate('currentContext'),
            children: [
              jsx.jsx(Row, {
                label: translate('pressure'),
                value: pressureTokens === undefined ? null : k(pressureTokens),
                raw: pressureTokens,
                suffix: 'tokens',
                hint: 'What the next request\'s prompt would cost',
              }),
              windowTokens !== undefined
                ? jsx.jsx(Row, {
                  label: translate('window'),
                  value: k(windowTokens),
                  raw: windowTokens,
                  suffix: 'tokens',
                })
                : null,
              // The bar carries the same fact as the rows above in the form a
              // reader can act on, so it is worth a line of its own.
              occupancy === undefined
                ? null
                : jsx.jsx(Bar, {
                  ratio: occupancy,
                  label: `${translate('occupancy')} ${(occupancy * 100).toFixed(1)}%`,
                }),
            ],
          }),

          jsx.jsxs(Section, {
            title: translate('archived'),
            children: [
              // Measured, not estimated: this figure is the meter's own
              // `shadowedTokenCount` summed over the folds, which is a better
              // number than the command plane can produce from bundle text.
              jsx.jsx(Row, {
                label: translate('archivedTokens'),
                value: k(status.archivedTokens),
                raw: status.archivedTokens,
                hint: 'Tokens the folds moved off the surface; still recoverable by recall',
              }),
              // How many ITEMS the folds took off the surface. The token figure
              // says how much; this says how much STUFF, which is the other half
              // of "what did folding do to my session". Not "messages": a folded
              // region carries user messages, assistant messages and tool
              // results, and a real session measured 48 + 82 + 81 = 211.
              jsx.jsx(Row, {
                label: translate('archivedItems'),
                value: status.archivedItems,
                hint: 'Messages and tool results the folds moved off the surface',
              }),
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
              // Shown only when non-zero: a permanent `Failed folds 0` trains a
              // reader to ignore the row, which is exactly the row that must be
              // noticed when it is not zero.
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
                : (usage !== null && status.pricedRoute !== ''
                  ? jsx.jsx(Row, { label: translate('noPrices'), value: status.pricedRoute, muted: true })
                  : null),
              status.resumed === true ? jsx.jsx(Row, { label: translate('resumed'), value: 'yes' }) : null,
              status.modelChanges > 0
                ? jsx.jsx(Row, { label: translate('modelChanges'), value: status.modelChanges })
                : null,
            ],
          }),

          // The provider's own cumulative split, which the panel used to
          // compress into one `Provider tokens` row. Shown as a nested block so
          // the four buckets read as parts of one measured total rather than as
          // four more independent figures — and the cache-hit share, the figure
          // the whole design is aimed at, leads.
          usage === null
            ? null
            : jsx.jsxs(Section, {
              title: translate('usage'),
              children: [
                cacheHit === undefined
                  ? null
                  : jsx.jsx(Row, {
                    label: translate('cacheHit'),
                    value: `${(cacheHit * 100).toFixed(cacheHit >= 0.995 ? 0 : 1)}%`,
                    hint: 'Cache reads as a share of the prompt side (uncached + cache reads)',
                  }),
                jsx.jsx(Row, {
                  label: translate('uncachedInput'),
                  value: k(usage.uncachedInputTokens),
                  raw: usage.uncachedInputTokens,
                  muted: true,
                }),
                jsx.jsx(Row, {
                  label: translate('cacheReads'),
                  value: k(usage.cacheReadTokens),
                  raw: usage.cacheReadTokens,
                  muted: true,
                }),
                usage.cacheWriteTokens > 0
                  ? jsx.jsx(Row, {
                    label: translate('cacheWrites'),
                    value: k(usage.cacheWriteTokens),
                    raw: usage.cacheWriteTokens,
                    muted: true,
                  })
                  : null,
                jsx.jsx(Row, {
                  label: translate('output'),
                  value: k(usage.outputTokens),
                  raw: usage.outputTokens,
                  muted: true,
                }),
              ],
            }),
        ],
      })
    }

    /**
     * Panel copy, in the two languages DSH ships.
     *
     * The panel used to be English-only while the host UI followed the user's
     * locale preference, so a `zh` deployment showed a Chinese harness with an
     * English panel. The active locale is read from the host at RENDER time
     * (see `translatorFor`), not captured at registration, because a language
     * change must not require re-registering the tab.
     */
    const STRINGS = {
      en: {
        tabTitle: 'Epistemic Fold',
        tabDesc: 'Context runtime status: archived history, folds, recall activity and estimated cost.',
        noSession: 'No active session.',
        currentContext: 'Current context',
        pressure: 'Pressure',
        window: 'Window',
        occupancy: 'Of window',
        archived: 'Archived history',
        archivedTokens: 'Archived tokens',
        archivedItems: 'Archived items',
        checkpointsNow: 'Checkpoints now',
        folds: 'Folds (lifetime)',
        leafFolds: 'Leaf folds',
        rootRebases: 'Root rebases',
        failed: 'Failed folds',
        retrieval: 'Retrieval',
        recalls: 'Recalls',
        searches: 'Searches',
        session: 'Session',
        model: 'Model',
        cost: 'Cost (estimated)',
        pricedWith: 'Priced with',
        noPrices: 'No prices for',
        usage: 'Provider usage (measured)',
        uncachedInput: 'Uncached input',
        cacheReads: 'Cache reads',
        cacheWrites: 'Cache writes',
        output: 'Output',
        cacheHit: 'Cache hit',
        resumed: 'Resumed',
        modelChanges: 'Model changes',
      },
      zh: {
        tabTitle: 'Epistemic Fold',
        tabDesc: '上下文运行时状态：归档历史、折叠次数、召回活动与成本估算。',
        noSession: '当前没有活动会话。',
        currentContext: '当前上下文',
        pressure: '压力',
        window: '窗口',
        occupancy: '占窗口',
        archived: '归档历史',
        archivedTokens: '归档 token',
        archivedItems: '归档条目',
        checkpointsNow: '当前检查点',
        folds: '折叠（累计）',
        leafFolds: '叶折叠',
        rootRebases: '根重基',
        failed: '失败折叠',
        retrieval: '检索',
        recalls: '召回',
        searches: '搜索',
        session: '会话',
        model: '模型',
        cost: '成本（估算）',
        pricedWith: '计价表',
        noPrices: '无价目',
        usage: '供应商用量（实测）',
        uncachedInput: '未命中输入',
        cacheReads: '缓存读取',
        cacheWrites: '缓存写入',
        output: '输出',
        cacheHit: '缓存命中',
        resumed: '已恢复',
        modelChanges: '模型切换',
      },
    }

    /**
     * The active locale id from the host, or `''` when unavailable.
     *
     * `ctx.get` is cordis's NON-throwing accessor — the same one this module
     * already uses for `sessions` — so a deployment without the locale service
     * reads `undefined` rather than throwing out of the panel's render.
     */
    const activeLocale = (ctx) => {
      if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return ''
      let service
      try {
        service = ctx.get('locale')
      } catch {
        return ''
      }
      const snapshot = service === undefined || service === null || typeof service.getSnapshot !== 'function'
        ? undefined
        : service.getSnapshot()
      const active = snapshot === undefined || snapshot === null ? undefined : snapshot.active
      return typeof active === 'string' ? active.toLowerCase() : ''
    }

    /**
     * A `t` bound to the HOST's locale, resolved on every call.
     *
     * Resolved per call rather than captured so a language switch is picked up
     * on the next render. The panel re-renders when its projection publishes,
     * so a switch without a subsequent event shows the old language until one
     * arrives — stale for at most one event, never permanently wrong, which is
     * the same bound the mode label already carries.
     */
    const translatorFor = (ctx) => {
      const t = (key) => {
        const active = activeLocale(ctx)
        // `zh-CN` and friends: match on the primary subtag.
        const table = active.startsWith('zh') ? STRINGS.zh : STRINGS.en
        return table[key] ?? STRINGS.en[key] ?? key
      }
      return t
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
        // The chip copy comes from the same locale resolver the panel uses, so
        // the two cannot disagree about the language. The panel resolves its
        // OWN translator from the tab props (see `EpistemicFoldPanel`), so no
        // `t` is passed here — the chip and the body read one source.
        const t = translatorFor(ctx)
        dispose = service.registerTab({
          id: TAB_ID,
          title: () => t('tabTitle'),
          description: () => t('tabDesc'),
          order: 60,
          single: true,
          component: (props) => jsx.jsx(EpistemicFoldPanel, props),
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
          const t = translatorFor(ctx)
          disposeType = tabs.register({
            id: NATIVE_ID,
            kind: NATIVE_ID,
            priority: 'extension',
            title: () => t('tabTitle'),
            // `description` is THUNKED copy, like `title` beside it: the guide
            // calls it as `entry.description?.()` on every render so a language
            // change needs no re-registration. Passing the string itself throws
            // `... is not a function`, and because the guide page is the doorway
            // to this type, the throw takes out the whole guide body — the entry
            // never appears and the tab cannot be opened at all.
            guide: [{ id: NATIVE_ID, order: 60, title: () => t('tabTitle'), description: () => t('tabDesc') }],
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
