# RC18 — The panel priced every session with the wrong rate card

A user reading the Sidebar's Session section said the `Priced with
deepseek-flash-2026-09` row was confusing. It was worse than confusing: the
figure beside it had been computed from a rate card belonging to a different
model, and then labelled with that model's name.

## 1. What the panel showed

The session in the screenshot ran on **Space Bunny Free** — an OpenCode Zen
route with no cost. The panel reported:

```
SESSION
Cost (estimated)          ~0.0044
Priced with               deepseek-flash-2026-09
Provider tokens           16k
```

`15_900 × 0.28 / 1e6 = 0.0045`. That is DeepSeek Flash's cache-miss rate applied
to a free route's tokens. The number was not merely mislabelled — it was
arithmetic on the wrong prices — and the label named the card that produced it,
which made the mismatch look intentional.

## 2. Why

`plugin.ts` registered the status projection with **one** profile:

```ts
...(profiles.length === 0 ? {} : { profile: profiles[0] }),
```

`profiles[0]` is `deepseek-flash-2026-09`, the first entry of
`BUILTIN_ECONOMICS_PROFILES`. The projection's own comment said a pure fold
"cannot resolve the routed model", so the caller had to choose — and choosing the
first entry meant every session, on every model, was priced with DeepSeek Flash.

The premise was wrong. The fold already receives every committed event, and
`request/header` carries the routed route:

```
EpochHeader { config: LlmCallConfig }   // provider, model, reasoning effort, …
```

That is the same field `routedTarget` reads on the host side
(`session.requestHeader()?.config`), so resolving the profile inside the fold
makes the two renderers agree by construction rather than by convention.

## 3. The fix, in three parts

**1. The fold records the route.** `FoldStatusState` gains `provider` and
`model`, written from each `request/header`. A `change` header replaces them,
which is what makes the price card follow a mid-session model switch. State
version bumped to 2, so persisted rows from the old shape are discarded rather
than forward-applied.

**2. The unit resolves the profile.** `StatusProjectionOptions.profile` becomes
`profiles`, and `view` looks up the one governing `state.provider/model`.

**3. `selectProfile`, not `resolveProfile`.** This is the subtle half. The two
differ exactly where this panel needs them to:

- `resolveProfile` falls back to a synthetic no-cache card when nothing matches.
  That is **right for the engine**, which needs a conservative upper bound so it
  never over-credits a saving on an unknown route. Its source comment says so.
- It is **wrong for an observation panel**. The fallback's `1.0/M` is a made-up
  rate. With it, the free route above reported a confident `~7.31`, which reads
  as "this session cost seven dollars".

So the panel uses `selectProfile` and renders `—` when no card matches, which is
the same rule it already applies to every other figure it cannot establish
(a `0` would read as "this mode is free"). The view also carries `pricedRoute`,
so the row can name what it could not price instead of leaving a bare dash that
reads as a panel failure.

## 4. What the panel shows now

```
SESSION
Cost (estimated)          —
No prices for             opencode-zen/space-bunny-free
Provider tokens           7258k
```

Observed in a real browser, against the same session whose model selector reads
`Space Bunny Free (OpenCode Zen)` — the two rows now name the same route, which
is the property that was missing. A route the deployment *does* price still gets
its own card and a figure; the change is a lookup, not a refusal to price.

### The command plane had the same defect

`/context status` resolved its profile with `resolveProfile` too, so it printed a
synthetic-priced figure for the same session. It now uses `selectProfile` as
well, and its unknown-cost line distinguishes the two cases it used to conflate:

```
cost:
  unknown         (no priced calls in this session)   ← no usage yet
  unknown         (no price card for this route)      ← usage, but no rates
```

The second line was previously unreachable, because the fallback always supplied
*some* card. Making the panel honest made it reachable, so the command had to
learn to say it.

## 5. Verification

Two tests in `tests/rc4-sidebar-panel.spec.ts`, both verified destructively:

- **prices with the list for THIS session's model.** Reintroducing
  `(options.profiles ?? [])[0]` fails it with
  `expected 'deepseek-flash' to be 'synthetic-no-cache'` — the defect, in the
  assertion message.
- **follows a mid-session model switch**, because the header is folded rather
  than captured at registration. The same revert fails it with
  `the switch must move the price list: expected 'list-a' to be 'list-b'`.

Full suite: **749 passed, 23 skipped**.

## 6. Lesson

Two distinct failures were stacked, and fixing the first exposed the second:

1. A figure computed from the wrong inputs.
2. A figure presented as known when the inputs were fabricated.

The first is a lookup bug. The second is the one the project's own rules already
covered — *never render a number you cannot establish* — and it survived because
the engine's fallback was reused for observation without asking whether a
conservative bound and an honest reading are the same thing. They are not: the
engine needs an upper bound, the panel needs a truth. The same resolver served
both, and only one of them could be right.
