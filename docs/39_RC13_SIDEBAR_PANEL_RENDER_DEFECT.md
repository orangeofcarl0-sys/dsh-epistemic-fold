# RC13 — The Sidebar Panel Renders an Error

**Severity:** the panel registers but cannot display anything.
**Found by:** the user ("sidebar 还没测试").
**Status:** FIXED and verified in the real browser.

---

## 1. The symptom

With the engine finally running (RC12), opening the right sidebar and selecting
the EF tab produces:

```
dsh-better-sidebar:
useProjection is not a function
[重试]
```

The tab itself is there — `TabItem "Epistemic Fold"` — and the registration
succeeds. It is the **render** that throws, caught by the sidebar's own
`RenderBoundary`.

## 2. Root cause

EF's panel destructures two props and calls one of them:

```js
const EpistemicFoldPanel = ({ useProjection, t }) => {
  const status = useProjection(STATUS_KEY)
  const pressure = useProjection('contextPressure')
```

with the comment *"Reads the projection through the props' own `useProjection`,
which the sidebar hands every tab component."*

**The sidebar does not hand it.** The installed `dsh-better-sidebar` is **0.24.1**,
and its `TabComponentProps` is explicit — *"Props every tab component receives
(builtins and external alike)"*:

```ts
interface TabComponentProps {
  ctx: Context;
  store: SidebarStore;
  scope: SessionScope;
  tab: SidebarTab;
  visible: boolean;
  expanded?, revealed?, onToggleDir?, onReferenceFile?, onOpenFile?, onOpenDiff?, onSubagentJump?
}
```

No `useProjection`. No `t`. The string `useProjection` appears **zero times** in
the entire sidebar package.

## 3. Is EF's pattern wrong, or is the sidebar missing something?

EF's pattern is **correct** — it is how DSH's own dock components receive the
hook. `dsh-client-ui-goal`'s `GoalDock` and `dsh-client-ui-conversation`'s
`ContextMeter` both destructure it exactly the same way:

```js
function ContextMeter({ useProjection, t }) {
  const pressure = useProjection("contextPressure");
```

Note that `ContextMeter` reads **`contextPressure`** — the same key EF reads.

The difference is **who mounts them**. DSH's docks are mounted by DSH's own
conversation/chat skeleton, which injects `useProjection` into the props it
passes. EF's panel is mounted by `dsh-better-sidebar`, a third-party plugin whose
tab contract does not include it.

So EF assumed a prop from a host it does not control, and the assumption was
never checked against the real host.

## 4. Why every existing test passed

This is the same class of failure as RC12, and worth stating plainly: **the tests
verified the registration and never executed the render.**

`tests/rc4-sidebar-panel.spec.ts` drives `apply()` against a fake service whose
captured descriptor is typed as:

```ts
let tab: { id: string; single?: boolean; title: () => string } | undefined
```

`component` is **not in that type at all**. The assertions are:

```ts
expect(tab?.id).toBe('epistemic-fold:status')
expect(tab?.single).toBe(true)
expect(tab?.title()).toBe('Epistemic Fold')
```

All three pass. Nothing calls `tab.component(...)`, so the prop shape was never
exercised. A repo-wide search for `.component(` in `tests/` returns nothing.

RC4's report described this as *"It renders, and unknown is `—`"* — but the
"minimal renderer" it refers to invoked `EpistemicFoldPanel` **directly**, with
hand-made props. Rendering a component directly proves the component works given
the right props; it does not prove the host supplies them. That gap is the defect.

The two failure modes now form a pattern in this project:

| | what was checked | what was assumed |
|---|---|---|
| RC12 | the preset named a module | that the module provides `compaction` |
| RC13 | the panel registered a tab | that the host passes `useProjection` |

Both times the check was one level away from the thing that mattered.

## 5. The fix

The panel now reads the projection through the path the sidebar itself uses:

```
ctx.sessions.list.getSnapshot()
  .projectionsBySession[sessionId]
  .values['epistemicFold.status']
```

with `entry.state` / `entry.error` carried through, and re-reads on the list's own
`subscribe` — the sidebar's wake-up path. `ctx.sessions` is not a guess: the
sidebar's own client calls it 17 times, and `projectionsBySession` is the same
shape its subagent catalogs already read.

The `useProjection` **prop is still honoured when a host supplies one**, because
it is the cheaper subscription and the idiom DSH's own docks use. Supporting both
is deliberate: the prop is preferred, the ctx path is the fallback that works on
the host we actually have.

The render is now pinned by `tests/sidebar-panel-render.spec.ts`, which builds
props from the sidebar's own `TabComponentProps` contract — `ctx, store, scope,
tab, visible`, deliberately **without** `useProjection` — and asserts:

1. the component renders without throwing;
2. the mode and figures reach the panel (`economy`, `47k`), and an unpriced cost
   is an em dash rather than a zero;
3. an absent projection renders the placeholder, not `NaN`;
4. a host that DOES supply the prop is still used;
5. the installed sidebar really has no `useProjection`, so the fallback stays
   necessary — the assertion that explains why the other four exist.

**Sabotage-verified.** Restoring the original `useProjection(STATUS_KEY)` call
reproduces the browser's exact error — `TypeError: useProjection is not a
function` — and fails 2 of the 5.

## 6. Verified in the real browser

After installing and restarting the profile, the panel renders EF's actual data
alongside the engine:

```
Epistemic Fold                                  economy
CURRENT CONTEXT
  Pressure                                      111k tokens
  Window                                        1000k tokens
ARCHIVED HISTORY
  Archived tokens                               0
  Checkpoints now                               0
FOLDS (LIFETIME)
  Leaf folds                                    0
  Root rebases                                  0
RETRIEVAL
  Recalls                                       0
  Searches                                      0
SESSION
  Cost (estimated)                              ~0.0482
  Priced with                                   deepseek-flash-2026-09
  Provider tokens                               3035k
Observation only — this panel reads a client projection and never enters the model context.
```

`economy` matches what `/context status` reports, so control and observation
agree. Cost and its profile id are real values read through the new path, not em
dashes. The error banner is gone.

## 7. What is NOT in question

- The engine runs: `/context status` reports `context mode: economy`.
- The tab registers with the right id, title and `single`.
- The projection itself is correct — the host side registers
  `epistemicFold.status` into `sessionProjections`, and that is separately tested.
- The client module loads with zero import errors (RC11, A5).

The break is exactly one thing: the panel's prop contract against
`dsh-better-sidebar` 0.24.1.
