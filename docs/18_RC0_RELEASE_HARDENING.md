# RC0 — Economy Default Release Hardening: Evaluation Report

**Branch:** `rc0-economy-release-hardening`
**Baseline:** `main@6b8a01b`
**Status:** hardening complete; **default flip BLOCKED** — the cost gate is OPEN
at the shipped defaults. See §4.

---

## 1. What RC0 was for

R4 ended with all five gate components satisfied and `mode: economy` available
but not default. RC0's job was not to add mechanism — it was to turn "research
eligible" into "safe to ship", by hardening the places where the configuration
and the evidence could still mislead.

The audit that opened RC0 found five such places. All five are fixed below, and
**one of them changed the headline conclusion.**

---

## 2. RC0-A — the configuration contract

A named mode has to mean one determinate behavior. Three places did not.

### 2.1 `mode: 'econnomy'` silently ran legacy

`isFoldModeName(config.mode) ? resolvePreset(...) : config` meant an unrecognized
mode fell through to engine defaults. The test was even *named* "rejects an
unknown mode name" while asserting the opposite — that an unrecognized mode is
ignored and the engine runs legacy.

That is the worst failure a named mode can have: the deployment asks for economy,
gets legacy, and nothing anywhere says so. It now throws, naming the valid modes.

### 2.2 Explicit `system-dedup` without a system prompt silently ran legacy framing

R3 fell back to `legacy` with a warning, reasoning that dropping the preamble
would trade correctness for tokens. That was right about the **danger** and wrong
about the **remedy**: a silent downgrade means the deployment does not get the
measured RBCR it asked for, while believing it does.

It now throws. No fallback was ever needed for the default path — the engine
default *is* `legacy` — so removing it costs a default deployment nothing and
makes an explicit request honest. Verified end to end: mounting `mode: economy`
without a `SystemPrompt` now rejects.

### 2.3 `REQUIRED_DSH_RANGE = '>=0.1.7-rc.2'` named a version that lacks the seam

The pinned vanilla build at `477b4f4` **is** 0.1.7-rc.2, and the seam was added
by our patch script. A semver range would tell a user their build "should"
support it. Replaced by a capability plus `DSH_SEAM_PROVENANCE`; the range is
left `undefined` until the seam lands upstream, and the error message no longer
mentions a version at all.

### 2.4 `src/effective-config.ts` — the configuration is now reportable

Reports what a configuration actually resolves to, with the **origin** of every
preset-owned setting (`preset` / `explicit` / `engine-default`), the user's
overrides, and any blocker — *without* throwing, so a preflight can surface a
problem before the engine refuses. The plugin logs it on mount, which is what
makes a failed mount diagnosable from the log alone.

A structural test asserts the `fallback` field is gone from the framing path, so
a future edit cannot quietly reintroduce the silent downgrade.

---

## 3. RC0-D — the release gates

### 3.1 The non-inferiority helper passed a total failure at n=1

`epsilon = ceil(total * 0.1)` gave `epsilon = 1` at `n = 1`, so "Basic 1/1,
candidate 0/1" was declared **NON-INFERIOR**. The test asserted that behavior.

R4's real result (20/20 vs 20/20) was never affected — the verdict is identical
for epsilon 0, 1 or 2 — but this would have become the long-term regression gate
after a flip, and a gate that passes a candidate which failed everything is not
a gate.

Replaced with a **pairwise** comparison keyed on `(family, replicate)`, which is
what the experiment actually is, gating on the count that matters:

```
N(reference pass, candidate fail) <= epsilon        default epsilon = 0
```

A test demonstrates why pairing matters: candidate and reference can have
**equal total passes** while the candidate regressed on a probe the reference got
right. Aggregate counting calls that clean; pairing does not.

### 3.2 Availability was folded into quality

R4-E correctly stopped scoring transport failures as wrong answers, then dropped
them entirely. They are neither. `summarizeAvailability` now reports availability
and retry load separately, and `availabilityNonInferior` gates
`A_candidate >= A_reference − epsilon_A`. An arm needing retries to reach the
same answers is not the same product, and that is now measurable.

Fixing this surfaced a real boundary bug in my own gate: `1 − 0.95` evaluates to
`0.050000000000000044`, so a candidate sitting *exactly* on a 0.05 threshold
failed it. The comparison now carries a 1e-9 tolerance, because the contract is
`>=` and a floating-point artifact must not flip it.

---

## 4. RC0-B/C — full-wire billing, and the finding that changed the conclusion

### 4.1 The method was wrong in two ways

R4-D collected bills by calling `adapter.stream()` from the **benchmark** with a
hand-built single-user-message request. That:

1. was **not the agent's wire shape** — no system prompt, no tool schemas, no
   real role structure — and the R3 framing saving is earned *through* that
   assembly; and
2. recorded **only main requests**, omitting Basic's real `purpose: 'compaction'`
   summary call, which understated Basic's bill.

`eval/live/recorder.ts` is now a pass-through `LlmAdapter` **decorator** at the
LLM seam, so the agent loop drives everything as it does in production and every
call is captured with its purpose:

```
DSH agent → ctx.llm → BillingRecorder → real provider adapter
```

`summarizeFullBill` prices all calls and splits the bill by purpose, because the
arms differ structurally: Basic pays for a summary per fold while economy EF runs
`semanticMode: none`. Retries are recorded and charged.

### 4.2 The finding

At the **shipped defaults** (131072 window, 65536 headroom → threshold 65024),
three workload families × 5 replicates:

| Workload | RBCR | Calls (E4 → B1) | Engagement |
|---|---:|---|---|
| FW-long-trajectory | 0.959 | 120 → 130 | 20 folds |
| FW-tool-heavy | 0.999 | 120 → 120 | **NULL — never folded** |
| FW-recall | 1.027 | 120 → 138 | 10 folds |

```
noise floor (two identical Basic runs): 1.007x
paired ratios (n=10): 0.960, 0.776, 0.959, 0.954, 0.956,
                      0.984, 0.962, 2.265, 0.959, 0.966
FullTaskRBCR mean 1.074, CI upper 1.353   →  GATE OPEN
```

**The mean is not the story.** Nine of the ten ratios sit in 0.776–0.984; one is
**2.265**. That is bimodal, not a spread, and the single point drags the mean
from ~0.95 to 1.074 and the CI upper bound to 1.353. The suite now reports the
distribution (median, p10/p90, min/max), counts ratios below 1, and **flags**
outliers rather than dropping them — deciding whether such a point is a real
mechanism difference or a measurement artifact requires looking at it.

The gate's own diagnosis is printed with the verdict: **the median is below 1
while the upper bound is not**, so it is OPEN because of *dispersion*, not
because the typical run is more expensive. More samples would only widen the
interval; the next step is diagnosing the outlier.

Two further findings from the same run:

- **The economy arm made FEWER calls than Basic** on both engaged families
  (120 vs 130 and 120 vs 138), because Basic pays for a compaction summary per
  fold while economy EF runs `semanticMode: none`. That is the RC0-B correction
  working — those calls were previously unrecorded.
- **15 folds and ZERO rebases across 15 runs.** The rebase path, which R3 and
  R4 both validated, does not engage at the shipped defaults at all — exactly
  what RC0-E predicts analytically.

So the effect is **far smaller than R4's 0.826**, and the upper bound is **above
1** — RC0 §18's gate is **NOT met**. R4's headline number was measured in a
6000-token window that forced frequent folding; at the defaults the mechanism
barely engages.

### 4.3 Two methodology errors caught while measuring, both mine

**Asymmetry.** The first full-wire run mounted `SystemPrompt` on the economy arm
only, making the wire shapes incomparable. With symmetry restored, the prompt
sequences became **byte-identical** on tool-heavy — which is what exposed the
next point.

**A 2.39× "regression" that was not one.** That first run reported tool-heavy at
2.39× with identical prompts and identical call counts, which no policy can
explain. A **noise-floor probe** (the same arm run twice) measures 1.005×, so the
effect was provider cache state at the time each arm ran. The probe is now part
of the suite, before any verdict is read. Without it I would have reported a 2.4×
regression that does not exist.

---

## 5. RC0-E — the shipped defaults imply a *different* regime

RC0 §19 raised this; RC0-C confirmed it; `eval/src/default-regime.ts` computes it
exactly from the config:

```
fold threshold   min(131072 × 0.8, 131072 − 65536 − 512) = 65024 tokens
rebase budget    24000 tokens (default)

→ a session needs ~65K tokens before ANY fold can happen
→ a rebase needs 800 folds at marker-only checkpoint size (~30 tokens),
  roughly 14,450 turns at 3600 tokens/turn
```

**The sharpest form of the finding:** the compressed window R3/R4 used is not
merely different — it is **unconfigurable at defaults**. The engine *refuses* to
resolve a 6000-token window against the default 65536-token headroom, because the
headroom alone exceeds the window. Those tiers had to switch the defaults **off**
to run at all. The regime they measured was not a stricter version of the default
regime.

This is **not** a claim that the rebase mechanism is broken. It engages for
state-rich checkpoints: at ~600 tokens/checkpoint a rebase needs 40 folds, about
722 turns — within a realistic session. The mechanism scales with checkpoint
size, and a marker-only checkpoint is simply too cheap for a 24000-token budget
to be crossed.

The preset also does not touch any operational knob: `mode: economy` sets four
**policy** keys and leaves headroom, threshold, and frozen budget at engine
defaults. If it retuned those, the measured regime would be a property of the
preset rather than of the engine.

---

## 6. RC0-F — the default flip: BLOCKED

| Component | Status |
|---|---|
| **R** Runtime | ✅ satisfied — seam is a compile-time contract; idle rebase on the production path |
| **C** Cost | ❌ **OPEN** — FullTaskRBCR mean 1.074, CI upper **1.353 > 1** (median 0.96; open due to dispersion) |
| **Q** Quality | ✅ satisfied — 20/20 vs 20/20 (R4-E, pairwise-verified) |
| **W** Window | ✅ satisfied — 46–47% of window, 0 overflows |
| **I** Invariants | ✅ satisfied — all zero-regression |

**The flip does not proceed.** `mode: legacy` remains the default. The preset is
available, tested, and safe to select explicitly.

This is the outcome the RC0 process was designed to produce. R4's evidence said
"eligible"; hardening the measurement said "eligible, but not at the defaults
you would actually ship". Those are different claims, and the second one is the
one that matters.

---

## 7. What RC0 establishes for the next decision

The remaining question is narrow and now well-posed:

> At the shipped defaults, EF's advantage is real but smaller than the CI bound
> can certify. What closes it?

Three candidate answers, in order of expected value, none of which is a new
architecture:

1. **Re-examine the default operational knobs.** `headroomTokens: 65536` on a
   131072 window means EF does not fold until 65024 tokens — and R4 measured its
   savings in a regime that folds at 5400. The headroom default predates all of
   this work and was never tuned against it. Retuning it is a *configuration*
   change, not a mechanism.
2. **Measure the state-rich regime**, where checkpoints are large enough for the
   rebase to engage (40 folds / 722 turns) and where W2's 6% premium is the known
   shape. The economy case may simply be the state-rich case.
3. **Only then** consider whether anything structural is missing.

The project's own discipline applies: no measured problem, no mechanism. RC0
found a measured problem — and it is a *configuration* problem, not an
architectural one.

---

## 8. What RC0 did NOT do

- **No default flip** (blocked, §6).
- **No bounded chain / M5.** Nothing measured reopens it.
- **No recall materialization pruning.** R4-A's gate passed; still skipped.
- **No `reliability` preset.** Still no live evidence for what it should be.
- **No M1, M3b, graph, embeddings, or learned policy.**
