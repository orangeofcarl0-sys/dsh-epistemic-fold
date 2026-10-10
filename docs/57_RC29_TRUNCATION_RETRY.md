# RC29 — a truncated summarization is retried, not abandoned

Status: landed. Supersedes nothing; it narrows the failure semantics in
[53_RC25_PR2_LANDED_AND_FOLD_CONTAINMENT.md](53_RC25_PR2_LANDED_AND_FOLD_CONTAINMENT.md).

## 1. The observable

Round 3b recorded nine `compactionFailures` of kind `truncated` — every one of them in
the `basic` arm, eight of them across three `unknown-config-semantics` cells. The error
is Basic's own:

    summarization truncated at the token cap (incomplete checkpoint)

RC25 made that failure SURVIVABLE: the fold is contained, the episode continues, and the
failure is counted and classified rather than killing the trial. That was right and it is
still right. What it left open is that the fold was still LOST — a fold that could have
succeeded on a second call was reported as a fold that failed.

## 2. Why the cap is hit at all

A reasoning model is billed for thinking and answering out of ONE budget. Measured on
`step-5-preview-free` summarising a 127K-token transcript, via the live route:

| cap | finish | reasoning tokens | content characters |
|---|---|---|---|
| 2048 | `length` | 1467 | 1539 |
| 4096 | `length` | 3920 | 666 |
| 8192 | `length` | 1639 | 19131 |
| 32768 | `stop` | 1928 | 3631 |

At 8192 the model wrote nineteen thousand characters and STILL hit the cap. Budgets
sized for a non-reasoning model — 2000, then 8192 as a headroom multiple — were sizing
the wrong quantity, because between 47% and 82% of the completion is reasoning.

Raising the budget lowers the probability and does not remove it: the same input at
16384 returned a 46,034-character summary and truncated, while 8192 and 32768 both
stopped early. `EF_TAU2_SUMMARY_MAX_TOKENS` is now 32768, and that is a mitigation, not a
guarantee. The retry is what covers the remainder.

## 3. Escalating, not repeating

A repeat at the same budget only helps when the overrun was a coin flip. The evidence
says it is a deficit — the same input truncated at every cap from 2048 to 16384 — so a
second call at the same budget reproduces the constraint that truncated the first. Each
retry therefore RAISES the budget: `base`, `2*base`, `4*base`, capped by
`EF_SUMMARY_RETRY_CEILING` (default 131072).

Escalation cannot turn a retryable truncation into a hard HTTP failure: the route was
probed at `max_tokens` 65536, 131072 and 262144 and answered HTTP 200 to all three,
rather than rejecting a budget above the model's nominal output size.

The alternative — accept the partial text — is deliberately rejected. A truncation can
cut any section of the checkpoint, and a checkpoint that silently omits `Critical
Context` is worse than a fold that failed loudly, because nothing downstream can tell
the difference.

`EF_SUMMARY_RETRY_ATTEMPTS` (default 2) restores the old behaviour when set to 0, so the
fix can be measured against what it replaced.

## 4. Where it lives, and where it must not

The retry is in [src/summary-retry.ts](../src/summary-retry.ts) and
[src/engine.ts](../src/engine.ts) — EF's own code.

It is NOT in `src/basic/`. That tree is regenerated from upstream by
[scripts/vendor-basic.mjs](../scripts/vendor-basic.mjs), and
[tests/rc7-vendored-basic.spec.ts](../tests/rc7-vendored-basic.spec.ts) fails on any edit
that is not a declared seam edit. Putting it there would either be reverted by the next
regeneration or would have to be smuggled into the framing seam, which is about framing.
A test pins that the vendored copy contains no retry.

The FIRST attempt is still `super.summarize` — Basic's own call, unmodified — so the
success path is unchanged and a fold that truncates nothing pays nothing. Only a retry
goes through EF's own invocation of `summarizeWithLlm`, because a raised budget is the
one thing Basic's call cannot express.

## 5. Every arm gets it, and that is a deliberate trade

A truncation is a property of the provider/model interaction, not of a compaction
strategy. `mode: basic` reaches the retry like any other mode, so the `basic` arm of a
comparison cannot be scored for surviving an artefact the EF arms were retried through.
Retrying only the EF arms would have manufactured the difference the benchmark exists to
measure.

The cost is stated rather than hidden: `mode: basic` is no longer indistinguishable from
native Basic on this ONE failure path. The checkpoint it produces when it succeeds is
unchanged.

## 6. Failure stays fail-closed, and the retry is visible

Every attempt truncating still throws, so a half-written checkpoint never lands as if it
were complete. The `truncated` classification and RC25's containment are untouched.

What is new is that a zero `truncated` count no longer has one meaning. It can be
"nothing truncated" or "the retry absorbed it", and those are different facts about the
provider. The transcript now carries `summarizationAttempts`, `summarizationRetries` and
`summarizationRetryExhausted` beside `compactionFailureKinds`, zeroed per episode like
every other counter.

## 7. What is verified

| claim | pinned by |
|---|---|
| the budget escalates, and never shrinks a configured one | `summaryRetryBudget` arithmetic |
| the policy reads the environment, falling back per field | `summaryRetryPolicy` with a malformed value |
| a truncated fold is answered on the retry | `tests/summary-retry.spec.ts`, through the real fold path |
| the retry escalates the `max_tokens` actually sent | the recorded call envelopes: 2000 → 4000 |
| every attempt truncating still throws | same file, against the Phase 7 message |
| a cancelled fold is never retried | the signal is aborted mid-flight; one call total |
| the success path makes exactly ONE call | no `failure` scripted; one recorded call |
| `EF_SUMMARY_RETRY_ATTEMPTS=0` restores the old behaviour | one call, then the error |
| the vendored Basic copy is untouched | RC7 drift test, plus a direct assertion |

## 8. One more thing this change needed

[tests/release-hygiene.spec.ts](../tests/release-hygiene.spec.ts) caught a hardcoded
absolute workspace path in the tracked `ef-phase7.sh` driver. The driver now takes
`LHTB_ROOT` from the environment and defaults to the LHTB checkout beside this repo,
which is the convention that test exists to enforce: only one machine can resolve a path
that names one machine.
