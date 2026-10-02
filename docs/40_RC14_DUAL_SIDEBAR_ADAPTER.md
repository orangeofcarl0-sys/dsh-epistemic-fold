# RC14 — Dual Sidebar Adaptation: Native and better-sidebar

**Status:** dual registration IMPLEMENTED; better-sidebar path verified live;
**native-only path NOT working and not verified.**
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

## 4. The native path does NOT work — root cause found

Testing it required a profile with EF and **without** better-sidebar. Booting
`ef-web` with `- id: better-sidebar / disabled: true` gives a configuration where:

- the app renders (`htmlLen` ≈ 545k) and the **native** sidebar is present
  (`data-sidebar-right` markers in the DOM);
- EF's client module **is** in the boot roster
  (`__DSH_BOOT__.entries` includes `dsh-epistemic-fold`);
- **no** console error, warning, or unhandled rejection is emitted;
- and yet the native sidebar shows only its own guide entry ("开始") — **EF's tab
  is absent**.

An instrumented build answered it: **`apply()` never runs.** Markers placed at
the top of `applyNativeSidebar` and inside its `ctx.inject` callback were never
set — not even the first one. So this was never a registration bug: the client
module's factory is never materialized at all.

### Why

The client module graph materializes a row when something **requires** it
(`materialize` is reached from the require path), and it stays connected through
`inject` edges. Every working UI module is injected by another module:
`dsh-client-ui-chat` injects `sidebar-right`, which injects `conversation`, and
so on.

**Nothing injects `dsh-epistemic-fold`** — verified across every
`@deepseek-ai/dsh-client-*` package: zero declare it in their
`dsh.client.inject`. EF injects `sidebar-right`; no edge points back at EF.

In the normal configuration this is masked: `dsh-better-sidebar` happens to sit
in the same application batch (batch 2, 15 entries vs 14), and its own activity
drags EF's factory in. Remove better-sidebar and EF has no inbound edge, so its
factory is never materialized — the module is served to the browser and listed in
the manifest, but never executed.

### Hypotheses tested and disproven

Each by a targeted experiment, before the instrumentation settled it:

| hypothesis | how it was disproven |
|---|---|
| `slots` must be injected alongside `sidebarRightTabs` | removing it changed nothing |
| the registration must run inside `ctx.effect` | wrapping it changed nothing |
| the outer `ctx` lacks the `slots` face | the face is present; using `injected` changed nothing |
| `ctx.slots` throws and is swallowed | an instrumented build captured no throw |
| the tab type id or kind is wrong | the same id registers fine on the better-sidebar path |
| the module fails to load | it is in the roster; the page logs zero errors |

### The fix direction

EF needs an **inbound graph edge** so its factory materializes without
better-sidebar. Tried and **disproven**:

- **`dsh.client.immediately: true`** — a real, validated field. Adding it does
  reach the boot manifest (the entry carries `immediately: true`, confirmed in the
  page), but the runtime does not act on it for materialization: the tab still
  does not appear. Reverted.

So the remaining candidate is to give EF an inbound edge from a module that
already materializes — e.g. a companion client entry that the sidebar or chat
surface requires. That is a packaging decision, not a code fix, which is why it
stops here.

Until it is settled, the accurate statement is:

> EF renders its panel on any deployment that has `dsh-better-sidebar`. On a
> native-only deployment the panel does not appear, because EF's client module is
> never materialized — nothing in the module graph requires it. The registration
> code is correct and tested; the module it lives in is simply never executed.

### What is genuinely uncertain

The dual registration is written to the documented native contract and covered by
tests, but the native half has **never been observed rendering**. The better-half
works; the native half is inert because its module never runs. Both facts are
stated above rather than papered over.

## 6. State at the end of this session

- `ef-web` is restored to its normal configuration (better-sidebar enabled); the
  panel works there.
- The native registration is in the code and covered by tests, but should be
  treated as **unverified**.
- The user's 3080 was never touched.
