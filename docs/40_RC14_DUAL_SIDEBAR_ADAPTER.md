# RC14 — Dual Sidebar Adaptation: Native and better-sidebar

**Status:** dual registration IMPLEMENTED; better-sidebar path verified live.
**Native-only path does NOT render.** The tab type registers successfully; the
body registration never fires, narrowed to one `ctx.slots.inject` call.
**Found by:** the user — *"对于 sidebar 的适配，要同时考虑原生 sidebar 以及 bettersidebar"*.

---

## 1. The gap, and why it is real

EF registered its panel with exactly one service:

```js
ctx.inject(['betterSidebar'], (sidebarCtx) => { … service.registerTab({…}) … })
```

On a deployment that has DSH's **native** right sidebar but not
`dsh-better-sidebar`, that callback never fires and the panel never appears.
That is a real configuration: the native sidebar ships with DSH, better-sidebar
is a third-party replacement, and a deployment can have either or both.

## 2. Why "better-sidebar is compatible with native" does not close it

`dsh-better-sidebar` depends on `@deepseek-ai/dsh-client-ui-sidebar-right` and
runs `registerNativeSurface`, which reads like a compatibility bridge. It runs
**the other way**: it pushes better-sidebar's own tabs *into* the native registry
(`for (const descriptor of service.getTabs()) registerDescriptor(descriptor)`,
where `service` is better-sidebar's own service and its UI renders from its own
`tabs` Map). Nothing copies native registrations back into better-sidebar.

The two keep separate registries with separate APIs:

| | native | better-sidebar |
|---|---|---|
| type | `ctx.sidebarRightTabs.register(definition)` | `ctx.betterSidebar.registerTab({ id, title, component })` |
| body | slot `sidebar.right.pane.tab`, keyed by the type id | the `component` field |
| body props | `{ hooks: { tabInfo } }` — **no `ctx`** | `{ ctx, store, scope, tab, visible }` |

## 3. What was implemented

`apply` performs both registrations, each guarded independently so a deployment
with neither sidebar still boots. The native half follows the documented
two-stage contract: the TYPE into `sidebarRightTabs`, the BODY into the
`sidebar.right.pane.tab` slot keyed by the same id. The native body closes over
`ctx` at registration time, because its props do not carry one — the same
technique better-sidebar uses for its own native bodies.

`NATIVE_ID` (`dsh-epistemic-fold`) is deliberately distinct from `TAB_ID`
(`epistemic-fold:status`), since the native registry documents `id` as unique
across all registrations and uses it as the slot key.

**Both registrations land.** Driving `apply()` with spies on each service:

```
betterSidebar.registerTab      epistemic-fold:status
sidebarRightTabs.register      dsh-epistemic-fold  kind=dsh-epistemic-fold  priority=extension
slots.inject                   sidebar.right.pane.tab
slots.register                 sidebar.right.pane.tab  key=dsh-epistemic-fold
```

**Tests** (33 in the two sidebar suites, 10 of them new): the native type, the
native body's presence, the native body rendering the same panel from its
closed-over context, the no-session state, and a deployment with **neither**
sidebar still booting.

**better-sidebar path re-verified live** after the change: the tab registers, the
panel renders EF's real data (`economy`, Pressure 111k, Window 1000k, Cost,
Provider tokens), no error banner. No regression.

## 4. The native path does not render — narrowed to one call

Testing it required a profile with EF and **without** better-sidebar. Booting
`ef-web` with `- id: better-sidebar / disabled: true` gives a configuration where:

- the app renders (`htmlLen` ≈ 545k) and the **native** sidebar is present
  (`data-sidebar-right` markers in the DOM);
- EF's client module **is** in the boot roster
  (`__DSH_BOOT__.entries` includes `dsh-epistemic-fold`);
- **no** console error, warning, or unhandled rejection is emitted;
- and yet the native sidebar shows only its own guide entry ("开始") — **EF's tab
  is absent**.

An instrumented build answered it (see below): the native path **does run**, and
the tab TYPE registers successfully. What fails is the BODY registration.

### Why — and how far the native path actually gets

Instrumenting the module (with markers anchored on exact whole lines, after two
earlier attempts mistakenly landed them inside a doc comment) produced the real
execution trace in the native-only configuration:

```
factory-called → apply → applyNativeSidebar → native-mount → tabs-resolved → type-registered
```

So the native path **does run**, and `sidebarRightTabs.register()` **succeeds**.
What never fires is the next step: `body-registered`. The tab type is registered
and the body slot is not, which is exactly the state the native sidebar renders as
an empty pane.

Two corrections to earlier conclusions in this document, both from my own
instrumentation errors rather than from the platform:

- An earlier run reported `apply()` never ran. That was wrong: the install had
  `package.json`'s `exports['./client']` pointing at **`lib/client.js`**, and I
  had been editing and copying only the root `client.js`. The served file was
  never the one I changed. The build (`scripts/build-plugin.mjs`) copies root
  `client.js` → `lib/client.js`, so both must be installed.
- A later run appeared to show the file was never executed. That was also wrong:
  the markers had been inserted into the module's doc comment, where they are
  inert text.

The lesson is narrow and worth keeping: **verify the served bytes before reading
any instrumentation result.** Checking `__DSH_BOOT__.entries[id].rev` against the
file's mtime, or fetching the entry URL and looking for the marker, would have
caught both mistakes immediately.

### What remains unknown

`body-registered` never fires and nothing is thrown (`__EF_ERR__` stays unset), so
`ctx.slots.inject('sidebar.right.pane.tab', …)` either is not reached or returns
without running its callback. `@deepseek-ai/dsh-client-ui-slots` — the package that
provides `ctx.slots` — has since been added to EF's `dsh.client.inject` (it is
present in `dsh-better-sidebar`'s list and was missing from EF's), which is the
right dependency regardless, but it did not by itself make the tab appear.

Until the body registration is understood, the accurate statement is:

> EF's panel renders on any deployment that has `dsh-better-sidebar`. On a
> native-only deployment the tab type registers successfully but its body does
> not, so the pane stays empty. The cause is narrowed to the single
> `ctx.slots.inject` call and is not yet identified.

### Honest state

The dual registration is written to the documented native contract and covered by
tests, but the native half has **never been observed rendering**. The better-half
works; the native half is inert because its module never runs. Both facts are
stated above rather than papered over.

## 5. State at the end of this session

- `ef-web` is restored to its normal configuration (better-sidebar enabled); the
  panel works there.
- The native registration is in the code and covered by tests, but should be
  treated as **unverified**.
- The user's 3080 was never touched.
