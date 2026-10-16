# 109 — The free model is only on the route that stalls the lane

Status: **bisection complete; the free model is not usable in this lane.** 2026-10-16. Parent `0e555d1`.

## A. Route and model separated at last

`cat-jam-free` exists on BOTH routes, which finally allowed the bisection I could not run before:

```
/zen/go/v1     + cat-jam-free                      -> WORKED (control: 7 calls in 3 min)
/inference/v1  + cat-jam-free, no headers          -> STALLED
/inference/v1  + cat-jam-free, WITH headers        -> STALLED
```

**The route is the discriminator, not the model** -- and the missing-header hypothesis is dead, since
supplying headers changed nothing.

## B. And the free model lives only on that route

```
/zen/go/v1     + deepseek-v4.1-flash-free  -> 400 {"message":"Upstream request failed: Model is unavailable."}
/inference/v1  + deepseek-v4.1-flash-free  -> 200, streaming, real usage
```

So the free model cannot be moved to the route that works, and the route that serves it is the one
that stalls. **Both halves are now measured rather than assumed.**

## C. Why the lane stalls there is still unknown

Eliminated across `docs/104`-`105` and this round: my two flags, the API key, the trial configuration,
streaming, the free tier's admission rules, `resolveLiveRoute`, `assertRouteRoutable` (it returns early
for anything that is not `/zen/go/v1`), and the header set. The bridge is idle with **zero TCP
connections**, so nothing has been attempted when it stops.

**I am not going to guess at the mechanism.** Four earlier guesses in this thread were each disproved
by the next measurement, and a fifth would be worth nothing.

## D. A real cause for `fetch failed`, from the runner's own comment

`scripts/run-lhtb.sh:366-371`:

> `opencode.ai` resolves to **nine A records, four of which refuse TCP 443**, and curl falls back
> across the set while **Node's fetch -- which the bridge is -- does not**. So curl reported 200 while
> every model call in the run died as `error:fetch failed`.

**That is the ten transport failures of the 2026-10-16 run.** It is a DNS multi-A-record problem, not
a provider fault and not a budget fault, and `docs/108`'s release fix now returns the budget those
failures were holding -- though whether they were pre-send or mid-flight is still open.

## E. Consequence

For the EF experiment the free model is **not a path**: it exists only on `/inference/v1`, which
stalls this lane before its first request. The usable choices remain the models proven on
`/zen/go/v1` -- `cat-jam-free` (natural completion, cleanest accounting) and the paid
`deepseek-v4.1-flash` (best score, 90.6% of the fold threshold).

**The invocation problem itself is solved**: the protocol is understood and our own code gets `200`
with real usage. What is not solved is that the lane cannot use the route that serves it.
