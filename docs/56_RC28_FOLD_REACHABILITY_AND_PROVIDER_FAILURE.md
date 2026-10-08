# RC28 — a fold that cannot converge, and a provider failure that looked like the model

This closes the two blockers an independent review of PR #3 identified, plus the
harness-fidelity defect that chasing the first one exposed. Nothing here is an EF
result: no arm has completed a trial, and no arm ranking is claimed.

Starting point: `main` at RC27 (`093c5d2`), **931 passed / 23 skipped / 0 failed**
on this machine after `npm run build` — measured, not carried over.
Ending point: **955 passed / 23 skipped / 0 failed**, three typecheck projects clean.

---

## 0. The finding that reframes PR #3's headline

PR #3 reports, reproducibly, on both economy passes:

```
still above threshold after 2 leaf fold attempts (68023 ... frozen prefix 180)
still above threshold after 2 leaf fold attempts (53447 ... frozen prefix  40)
```

and reads it as: *"the summary succeeded, twice, and the foldable prefix was 180
and 40 tokens."* Four things are wrong with that sentence, and the fourth is the
one that changes what the failure means.

### 0.1 `frozenTokens` is not the foldable prefix

It is the token cost of the frozen EF **checkpoints** — the part a leaf cannot
touch. `openTokens = totalTokens - frozenTokens` ([pressure.ts:90-91]). At 53-68K
total, the open content was ~53-68K. There was plenty to fold; the selector would
not take it. The two numbers are not the same metric, and the report inverted the
meaning of the one it quoted.

### 0.2 A single oversized node is un-foldable by construction

Both selectors walk the surface from the tail and `break` as soon as
`retainTokens` is met:

```ts
// src/basic/region.ts:145-152, and identically in src/leaf-policy.ts:57-63
for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
  accumulated += pricedNodes[index]!.tokens
  keepFromIdx = index
  if (accumulated >= retainTokens) break
}
```

At `retainTokens = 0` that break fires on the **first iteration**, so the last
node is retained at every setting. A node larger than the threshold can therefore
never be folded away. Measured on a 66K surface whose last node was a 60K tool
result:

| selector | retention | foldable | retained |
|---|---|---|---|
| leaf | 5120 | 6096 | 60020 |
| rebase | 0 | 6096 | 60020 |

**This is why "escalate to Root" cannot be the fix.** The report's proposed remedy
would convert a loud throw into a silent non-convergence, because the rebase
retains the same tail. `tests/fold-reachability.spec.ts` measures this rather than
asserting it.

### 0.3 "2 leaf fold attempts" was a constant

`src/engine.ts` printed `spec.compactionRetries + 1`. The loop can also `break` on
a null span ([engine.ts:810-812]), so it claimed two attempts after **one**
committed fold. Reproduced: `leafFoldCount === 1` beside a message saying "2 leaf
fold attempts". Phase 7 cited that sentence as evidence; it could not support it.
The message also printed only `frozenTokens`, never `frozenCount` or the span, so
1×180 and 2×90 were indistinguishable.

### 0.4 The harness omitted a service production mounts — and that is the real cause

`dsh-base`'s own preset mounts the tool-result pruner:

```yaml
# dsh-base/cordis.patch.yml:418
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

The EF engine **already reads it** (`ctx.get('toolResultPruner')` in
`compactIfNeeded`). The harness mounted **nothing**, so the prune step never ran.
And LHTB's oversized node *is* shell output — a `tool/result` — which is precisely
what the pruner targets. Measured, same session, same config, the mount being the
only difference:

```
without the pruner   before=66116 after=60136  leaves=1  still over threshold
with the pruner      before=66116 after=7406   leaves=0  converged
```

So `pressure-unresolved` was, at least in part, a property of the **harness**, not
of EF. This is the same class of defect as RC23–RC25: the benchmark measured a
configuration that cannot ship.

**What the pruner does not fix**, and why the engine-side guard is still needed:
the pruner collects only `event.type === 'tool/result'`. An oversized user or
assistant message is not prunable, and the retention theorem still protects it.

---

## 1. P0-1 — a fold that cannot reach the threshold

### 1.1 The pre-flight, placed correctly

`assessFoldReachability` ([fold-economics.ts](src/fold-economics.ts)) computes, before
attempting anything: the widest legal span, the checkpoint that span would leave
behind, and the remainder that would survive. `canReachThreshold` is
`retainedTokens < thresholdTokens`.

**Placement is the load-bearing part, and my first attempt got it wrong.** Gating
the FIRST fold looked correct and broke the I1 gates: a first fold is legitimate
even when it cannot reach the threshold, because it reduces pressure *and grows the
frozen prefix* — which is the only mechanism that eventually makes `frozen-bound`
reachable and hands the surface to a rebase. Measured with the guard before the
loop: a 14-step workload stopped folding at step 8 and never reached
frozen-bound, so `tests/convergence-contract.spec.ts` failed with *"the workload
never reached frozen-bound; the gate is untested."* A worse bug than the thrash
being prevented.

The guard therefore sits **after a fold and before the retry**, recomputed from the
current measurement. What must not happen is the second fold: if the widest span
cannot reach the threshold, the surface is a fixpoint of this action.

The outcome is a clean stop with the arithmetic logged, not a throw — the surface
is recoverable, and the caller keeps the fold that did commit.

### 1.2 The count and the arithmetic are now real

The terminal message reports `committed` folds and the full reachability line
(span, checkpoint, remainder, frozen prefix and its count). `lastFoldReachability`
is exposed on the engine and reported, so the state is readable instead of
inferred.

---

## 2. P0-2 — provider failure semantics

Three unrelated causes collapsed into one observable, and the observable was
attributed to the model:

| cause | finish reason | content |
|---|---|---|
| HTTP 429 | `LIVE_HTTP` | none |
| truncated at the cap | `max-tokens` | none, or partial |
| genuinely silent model | `stop` | none |

All three reached the agent as `content == ""`, so all three counted toward
`empty_streak`, appended a fabricated *"your last reply was empty"* message to the
conversation, and could end the episode at `MAX_EMPTY_STREAK = 5`. That is how
provider load became indistinguishable from mode quality: pass 2 ran at a **14%**
429 rate against pass 1's **7%**, and its two `vector-db` cells died after 7 and 16
model calls.

### 2.1 The bridge appends nothing for a failed call

`session.append('assistant/message', …)` ran **unconditionally**, before the bridge
knew whether the call had succeeded. A 429 therefore wrote an empty assistant turn
into the durable session — metered, foldable, and read back to the model as its own
prior output. The failure branch now runs first, closes the turn (an unclosed turn
is illegal), appends nothing, and returns the failure in the reply.

`providerFailures` / `lastProviderError` are reported separately from `modelCalls`,
because a failed call is not a model turn and produced no surface node.

### 2.2 The adapter retries a 429, bounded, honouring `Retry-After`

The adapter was single-shot: no retry, no `Retry-After`, no backoff. A rate limit
is transient, so retrying is the correct response — but an unbounded retry turns an
outage into a hung benchmark, and the episode budget is the thing being measured.
So: at most three retries, waiting the provider's own `Retry-After` (clamped at
30s, because a provider may ask for minutes) or an exponential backoff. **5xx is
deliberately not retried** — a different fault, and silently retrying it would hide
the outages the run needs to record. `rateLimitTelemetry` exposes how much of a run
was throttling.

### 2.3 The agent distinguishes the cases

- A provider failure is branched on **before** the empty-reply handling, counted
  against its own ceiling, and appends **no nudge** — the model never saw the
  request, so there is nothing to answer.
- `MAX_PROVIDER_FAILURES` (12) is deliberately larger than `MAX_EMPTY_STREAK` (5):
  a provider recovering is worth waiting for; a model that keeps saying nothing is
  not. One ceiling cannot serve both.
- A reply finishing `max-tokens` **with partial text** is no longer read as a
  completion. That was the quieter misreading — it ended a task with no anomaly
  recorded anywhere.

### 2.4 The termination reason is recorded

`context.metadata` carried only arm/telemetry/shell_calls, and grep for any
termination field returned nothing — so "died after 7 model calls" was
**structurally** unattributable, not merely unrecorded, and no rerun of the
collector could recover it. `ef-lhtb-transcript/3` now carries `termination` and
`provider_failures`; a `/2` reader finds them absent and skips, which is the right
degradation. `scripts/ef-collect.py` reads both and reports `MISSING` rather than
inventing a reason.

---

## 3. What is verified

Every fix is pinned by a test that fails when the defect is reintroduced, checked
destructively rather than asserted:

| fix | test | destructive check |
|---|---|---|
| reachability guard | `fold-reachability.spec.ts` | guard removed → 2 fail |
| pruner mount | `fold-reachability.spec.ts` | mount removed → 2 fail |
| real fold count | `fold-reachability.spec.ts` | pattern restored → fails |
| 429 retry + `Retry-After` | `provider-failure-semantics.spec.ts` | retry removed → 3 fail |
| no phantom turn | `provider-failure-semantics.spec.ts` | order reversed → fails |
| no false completion | `provider-failure-semantics.spec.ts` | branch disabled → fails |

## 4. What is not claimed

- **No arm ranking, and no sample.** No arm has completed a trial.
- **No claim that `pressure-unresolved` is gone.** It is now *rare* in the
  configuration that ships, and its remaining cases are diagnosable — but no live
  run has been made with the pruner mounted, so the count is unmeasured.
- **No claim that the pruner explains every occurrence.** The two Phase 7 failures
  are consistent with it, and the mechanism is demonstrated synthetically; the
  live archives cannot be re-read for span sizes, which is what would confirm it
  case by case.
- **No claim about the provider's 429 behaviour being stable.** Three retries
  cleared the synthetic cases; the measured 2-14% rate is one observation window.
- **No re-use of the old `roots=0` finding.**
- **`vector-db-iterative-build` still cannot discriminate** (its reference solution
  tops out at 0.8327).

## 5. State of the lane

Both P0s are addressed in code, and the third defect — the missing pruner — is the
one that most changes what the last measurement meant. What remains is not a code
change: the container-memory constraint from Phase 6, and the requirement that the
arms be **blocked** rather than run back-to-back.

A sweep can now run the four arms on `unknown-config-semantics`, and the report it
produces can attribute a cell's death without a rerun, because `termination` and
`provider_failures` are in the archive.
