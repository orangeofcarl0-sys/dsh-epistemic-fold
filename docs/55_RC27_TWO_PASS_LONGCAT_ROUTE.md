# RC27 — Phase 7 measured twice per arm on the LongCat route

Status: **measurement complete; no arm ranking is claimed and none is available.**
Scope: the `basic` and `economy` arms only, two passes each, on
`longcat-2.5-preview-free` via `https://opencode.ai/zen/go/v1`.

Companion to `50_PHASE7_HANDOFF.md`, which defines the fields and the non-claims.
This record supersedes nothing in it; it supplies the numbers §5 said a single
replicate could not support.

---

## 1. Why this route, and why two passes

`space-bunny-free` on `/zen/v1` answers `429 FreeUsageLimitError`, and the other five
`-free` models answer `403 FreeTierError` ("free tier can only be used from within
OpenCode"), so no free substitute existed on that route. LongCat lives on
`/zen/go/v1`, which requires an `x-opencode-session` header; `scripts/run-lhtb.sh`
derives it from the base URL rather than from a flag.

Handoff §5 forbids ranking arms from one replicate. Two passes per arm is the
cheapest form of the measurement that can show whether a number is a property of
the arm or of the run. Section 5 below reports what it showed: **it is a property
of the run.**

## 2. Provenance

| run | revision | schema | wall clock |
|---|---|---|---|
| basic pass 1 | `165025b` | `ef-lhtb-transcript/2` | 4h39m |
| basic pass 2 | `093c5d2` | `ef-lhtb-transcript/2` | 5h34m |
| economy pass 1 | `093c5d2` | `ef-lhtb-transcript/2` | 8h32m |
| economy pass 2 | `093c5d2` | `ef-lhtb-transcript/2` | 5h28m |

All four runs are `dirty: true` — the Phase 7 driver is an untracked local script,
which is itself recorded in the archive rather than hidden.

Passes ran **sequentially**, not concurrently, so both arms share one container
budget. That is the condition §5 requires before any comparison can be attributed.

## 3. Every cell

`prompt` is `promptTokensLast` — the last measured request, not a mean.

| arm/pass | task | reward | calls | prompt | folds | bundleWrites | bundlesPresent | pendingIntents | compactionFailures | kinds |
|---|---|---|---|---|---|---|---|---|---|---|
| basic p1 | unknown-config | 0.0 | 19 | 9,017 | 0 | 0 | 0 | 0 | 0 | `{}` |
| basic p1 | unknown-config | 0.0 | 17 | 7,890 | 0 | 0 | 0 | 0 | 0 | `{}` |
| basic p1 | vector-db | 0.0948 | 81 | 11,660 | 0 | 0 | 0 | 0 | 0 | `{}` |
| basic p1 | vector-db | 0.0000 | 34 | 12,880 | 0 | 0 | 0 | 0 | 0 | `{}` |
| basic p2 | unknown-config | 0.0 | 67 | 15,803 | 0 | 0 | 0 | 0 | **17** | `{truncated: 17}` |
| basic p2 | unknown-config | 0.0 | 23 | 15,305 | 0 | 0 | 0 | 0 | **2** | `{truncated: 2}` |
| basic p2 | vector-db | 0.0815 | 78 | 15,030 | 0 | 0 | 0 | 0 | 0 | `{}` |
| basic p2 | vector-db | 0.0000 | 37 | 14,923 | 0 | 0 | 0 | 0 | 0 | `{}` |
| economy p1 | unknown-config | 0.6724 | 313 | 9,450 | 12 | 12 | 12 | 0 | 0 | `{}` |
| economy p1 | unknown-config | 0.0 | 67 | 13,271 | 2 | 2 | 2 | 0 | 0 | `{}` |
| economy p1 | vector-db | 0.8045 | 62 | 8,803 | 3 | 3 | 3 | 0 | 0 | `{}` |
| economy p1 | vector-db | 0.0 | 285 | 10,610 | 14 | 14 | 14 | 0 | **1** | `{pressure-unresolved: 1}` |
| economy p2 | unknown-config | 0.0 | 139 | 5,748 | 18 | 18 | 18 | 0 | 0 | `{}` |
| economy p2 | unknown-config | 0.0 | 49 | 5,432 | 7 | 7 | 7 | 0 | **1** | `{pressure-unresolved: 1}` |
| economy p2 | vector-db | 0.0 | 7 | 11,297 | 0 | 0 | 0 | 0 | 0 | `{}` |
| economy p2 | vector-db | 0.0 | 16 | 11,053 | 0 | 0 | 0 | 0 | 0 | `{}` |

## 4. The invariants held: 16 of 16

- **I1** `bundleWrites >= folds + roots + emergencies` — holds on every cell. On
  the `economy` arm it holds with **exact equality**, which is the stronger form:
  12/12, 2/2, 3/3, 14/14, 18/18, 7/7. A basic arm cannot exercise this invariant at
  all (all terms are 0), so the `economy` cells are the only real test of it here.
- **I2** `pendingIntents == 0` — holds on every cell. No producer without a
  consumer in any of the 16.
- **I3** basic arm has no bundle store — holds on all 8 basic cells
  (`bundleWrites = 0`, `bundlesPresent = 0`).

## 5. What two passes actually bought: the numbers are not stable

### 5.1 The truncation did not reproduce

| | basic p1 | basic p2 |
|---|---|---|
| `truncated` failures | **0** | **19** |
| agent-side empty `max-tokens` responses | 17 | 34 |
| agent-side HTTP 429s | 3 | 11 |
| prompt tokens (max cell) | 12,880 | 15,803 |

Same arm, same model, same config, same route. **Nineteen failures in one pass and
zero in the other.** A single run's failure count is therefore a **reading, not a
property of the arm** — which is exactly what §5 says a replicate cannot settle.

### 5.2 The rewards did not reproduce either

| arm | pass 1 mean | pass 2 mean |
|---|---|---|
| basic | 0.024 | 0.020 |
| economy | **0.369** | **0.000** |

The `economy` passes disagree completely. Ranked on pass 1, `economy` looks far
ahead of `basic`; ranked on pass 2 it is behind. **No arm ranking is claimed here,
and this table is the reason.**

### 5.3 The provider was not in the same state

| run | agent calls | agent 429s | rate |
|---|---|---|---|
| basic p1 | 151 | 3 | 2% |
| basic p2 | 205 | 11 | 5% |
| economy p1 | 727 | 51 | 7% |
| economy p2 | 211 | 30 | **14%** |

`economy` pass 2 ran with roughly seven times the upstream-failure rate of pass 1,
and its two `vector-db` cells died after **7 and 16 model calls**. Attribution
across arms — which §5 already forbids from one replicate — is not available from
these two passes either, because the arms did not run under the same conditions and
neither did the two passes of one arm.

## 6. The one finding that IS reproducible

Both `economy` passes failed the same way, on different cells at different sizes:

`
pass 1  still above threshold after 2 leaf fold attempts (68023 estimated tokens >= threshold 16000, frozen prefix 180)
pass 2  still above threshold after 2 leaf fold attempts (53447 estimated tokens >= threshold 16000, frozen prefix  40)
`

Read it as: **the summary succeeded, twice, and the surface was still over
threshold.** The foldable prefix was 180 and 40 tokens — essentially nothing —
against a live surface of 53–68K tokens. EF ran its fold attempts, could not bring
the surface down, and stopped.

This is a different fault from a truncated summary, and it is stable across runs
while the truncation is not. It now has its own kind, `pressure-unresolved`.

The code is attached where EF raises it, in `src/engine.ts`. It is deliberately
NOT attached in `src/basic/index.ts`, which raises the same failure in Basic's own
wording: that tree is a byte-identical vendored copy of
@deepseek-ai/dsh-compaction-basic@ — enforced by `tests/rc7-vendored-basic.spec.ts` — so
editing it would rot the fork. Both wordings are caught by the message fallback in
the classifier, which is what makes the code an optimisation rather than the only
path. Before this, the fault landed in `other`, sharing a bucket with genuinely
unknown faults — the conflation the kind split exists to end.

## 7. What is NOT claimed about the truncation

The truncation is `finish_reason: length` reported by the provider on a compaction
call, which Basic fails closed on as an incomplete checkpoint. Two things are
established about it and one is not.

**Established: it is not "Basic's checkpoint body is too large".** Measured
directly against the real model through the repo's own harness with the real
adapter: a **17,821-token** compaction input produced a **203-token** summary and
finished `stop`. Synthetic inputs from 3K to 43K tokens produced 145–590 token
summaries, all `stop`. The 8192 budget is 14–40× more than the summary needs.
`50_PHASE7_HANDOFF.md` §4 previously claimed this question "surfaces as a
`foldFailures` count ... which is the measurement that can answer it"; that claim
has been corrected in place.

**Established: it is not the provider failing.** A provider outage raises a
*different* error — `LIVE_HTTP`, reproduced directly — not the truncation. The two
are now separate kinds and the 16 cells show both.

**Not established: why the provider returns `length`.** The leading candidate is
that a reasoning model's reasoning tokens are charged to the same `maxTokens`
budget, so the call can exhaust it before emitting content. Two signals support it:
the agent's own calls fail identically and simultaneously (empty `max-tokens`
responses, five in a row, until `MAX_EMPTY_STREAK` ends the episode), and all four
runs show agent-side empty `max-tokens` responses. It could **not** be reproduced
synthetically — a 47K-token messy tool-heavy context still returned a tool call —
so it is recorded as open rather than asserted.

One consequence is worth stating even while the cause is open: worse-case
`foldIfNeeded` runs before **every** `modelTurn`, so a failing fold is retried on
every subsequent step while the surface stays above threshold. On the worst cell,
17 of 67 model calls were preceded by a doomed compaction. A contained failure is
recoverable, but it is not free.

## 8. Harness changes this measurement produced

| change | why |
|---|---|
| `foldFailures` → `compactionFailures`, `lastFoldError` → `lastCompactionError` | the call counted is `compactIfNeeded`, which on `basic` is Basic's summarization. A basic cell reporting `folds: 0` beside a non-zero count was correct data under a false label. |
| `compactionFailureKinds` added | one number merged a summarization budget error with a provider HTTP 500, and only the last message survived. |
| `pressure-unresolved` split out of `other` | it recurred in both passes, so it is a known fault and not an unknown one. |
| schema `/2` | the field names changed; a `/1` reader skips what it cannot find rather than reading a renamed field as zero. |
| collector reads `provenance.ef.rev` | it had been printing `revision=None` on archives that name their revision. |
| runner writes `model_name` from `EF_LIVE_MODEL` | Harbor printed `space-bunny-free` while every call went to LongCat. |

## 9. Open

1. **Why does the provider return `length` on a ~15–16K-token compaction input**
   while a 43K-token synthetic one summarizes cleanly? Either the reasoning budget
   is the answer, or there is a property of the real agent surface that these
   synthetic inputs do not have. A bridge-side dump of one failing compaction
   request and response would settle it.
2. **Should `pressure-unresolved` be retried at all?** The fold is known to have
   nothing to archive when `frozen prefix` is ~40 tokens; attempting it twice and
   then failing is defensible, but it is worth asking whether the measurement can
   be taken before the attempts.
3. **`EF_BRIDGE_MAX_TOKENS = 4096` and `EF_TAU2_SUMMARY_MAX_TOKENS = 8192` are
   budgeted as if reasoning were free.** If the candidate above holds, both are
   undersized on a reasoning route for a reason unrelated to how much text is
   wanted.
