# RC17 — One guide entry, not two

RC14 made EF register with both sidebars, on the stated grounds that they keep
separate tab registries so a panel in one is invisible in the other. That
premise is true, and the conclusion was still wrong: registering with both
produced a **duplicate the user can see**. This document records the defect, the
mechanism, the fix, and the second bug the fix's own test found.

## 1. The defect

With `dsh-better-sidebar` installed, the right sidebar's guide page listed:

```
文件          文件变动        新建终端        任务管理        侧边对话(beta)
Epistemic Fold
Epistemic Fold        ← the same entry, twice
```

Both entries had the same title, the same cube glyph, and the same behaviour.
Measured in a real browser, picking either one opened its own tab — so a user
who clicks both ends up with two identical "Epistemic Fold" tabs and no way to
tell them apart.

The two entries were **not** duplicates in the registry's sense: their kinds
differ (`epistemic-fold:status` and `dsh-epistemic-fold`), which is exactly why
the registry's own duplicate-id and kind-collision guards never fired.

## 2. The mechanism

`dsh-better-sidebar` is a **replacement** for the native right sidebar that also
bridges its own tabs **into** the native registry, so DSH's own surface can show
them. The bridge is `registerNativeSurface`, and for every registered descriptor
it contributes a native type **plus a guide entry**:

```js
tabs.register({
  id: `dsh-better-sidebar:${descriptor.id}`,
  kind: descriptor.id,                       // ← the descriptor's own id
  priority: 'extension',
  title: () => titleOf(descriptor),
  ...descriptor.hidden === true ? {} : { guide: [{ id: descriptor.id, … }] },
})
```

So EF's better-sidebar registration (`TAB_ID = 'epistemic-fold:status'`) already
lands in the native registry, guide entry included. EF then added its own native
type (`NATIVE_ID = 'dsh-epistemic-fold'`) on top — a second entry for the same
panel.

The bridge is unconditional: it does not consult `isTabEnabled`, so no setting
avoids it.

## 3. The fix: the native half is a fallback

`applyNativeSidebar` now registers its type only when nothing else already
provides one, and retracts it if something later does.

The signal is read off the **registry**, not from service presence:

```js
const bridged = tabs.get(TAB_ID)   // 'epistemic-fold:status'
```

`TAB_ID` is EF's own descriptor id, so a kind registered under it can only come
from better-sidebar's bridge. Service presence would be the wrong test: a
mounted better-sidebar whose bridge has not run, or failed, would suppress EF's
own entry and leave the panel unreachable — the bridge, not the service, is what
creates the duplicate.

`tabs.subscribe(reconcile)` makes the decision **order-independent**. `ctx.inject`
callbacks are asynchronous (measured: a callback for an already-provided service
still fires a microtask later, and one for a service that never appears never
fires), so either registration can land first; whichever arrives second wakes
the other through the registry change.

## 4. The second bug — found by the fix's own test

The first version of `reconcile` registered directly. The test hung with:

```
RangeError: Maximum call stack size exceeded
```

`tabs.register` **synchronously notifies subscribers**: the registry calls its
own `refresh()` inside the registering `ctx.effect`, and `refresh()` publishes to
every listener. So the sequence was

```
reconcile → register → notify → reconcile → register → …
```

— unbounded recursion, in production as well as in the test. A reentrancy guard
is therefore load-bearing, not defensive:

```js
let reconciling = false
const reconcile = () => {
  if (reconciling) return
  reconciling = true
  try { reconcileOnce() } finally { reconciling = false }
}
```

The guard is safe because a registration made *by* this function cannot change
the answer to the question it asks: only the bridge can introduce `TAB_ID`.

**Destructive verification.** Removing the guard (replacing its condition with
`if (false) return`) makes two of the three RC17 tests fail with that exact
`RangeError`. Restoring it makes them pass. The guard is the reason they pass,
not an incidental detail.

## 5. What was observed

| deployment | guide entries for EF | panel opens |
| --- | --- | --- |
| better-sidebar installed | **1** — `epistemic-fold:status` (the bridged one) | yes, real data |
| native only | **1** — `dsh-epistemic-fold` (the fallback) | yes, real data |

Both were driven in a real browser against `ef-web`. In the native-only case the
entry also carries its description line, which the duplicated version had lost:
with better-sidebar installed the guide listed **seven** entries, past the
native guide's `MAX_DESCRIBED_ENTRIES = 4`, so every description was dropped and
the two EF entries became pixel-identical.

## 6. Tests

`tests/rc4-sidebar-panel.spec.ts` gains a `RC17` block with three cases:

- registers **no** native type when the bridge already published one;
- registers the native type when nothing did;
- reconciles a **late** bridge through the subscription, retracting EF's own
  entry when the bridged kind appears.

The registry stub reproduces the real API surface the code depends on
(`register` / `get` / `subscribe`) including the synchronous notification that
caused the recursion, and its disposer removes its own entry by identity rather
than by position.

Full suite: **747 passed, 23 skipped**.

## 7. Lesson

The RC14 premise — "the registries are separate, so register with both" — was
verified and still produced the wrong design, because it stopped at the
registries and never asked what the *user* would see. The two entries were
distinguishable to the registry (different kinds) and indistinguishable to a
person. A compatibility layer that bridges in one direction can turn a correct
registration into a visible duplicate, and the only way to catch that is to look
at the rendered surface rather than the registration calls.

The reentrancy bug is the same lesson from the other side: the test that found
it was written to check a *policy* decision, and it found a *crash* instead.
Both were worth having.
