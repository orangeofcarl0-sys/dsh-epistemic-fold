# EF-R2 — Effective Compaction & Rationale Causality

Status: **complete, offline**, 2026-11-10. No live model call was made in this
round. No merge, release or deployment was performed. Semantic Active remains
on Deployment Hold. The supported-lane CI passed on `4af0eea` (run
42804489967); the DSH-master compatibility probe failed as expected and is
non-blocking.

This round did not add a recall prompt, a locator variant or a semantic memory
component. It asked a smaller and more useful question: **what did the
compaction transactions in the EF-R1 evidence actually do, and what is the
evidence allowed to say about them?**

The answer changed three EF-R1 readings. The ITT numbers did not change.

---

## 1. What this round found

1. **The 31 E1 "failed folds" are not rationale-provider failures.** Every one
   reached DSH Basic's shrink check. Every rationale call returned a non-empty
   body. The body was larger than the span it would replace.
2. **The 120-cell E1 arm is not the shipped economy tier.** The E2E host never
   passed `leafAdmission`, so the plugin default `legacy` applied. All three
   shipped tiers set `leafAdmission: economic`. The arm is
   **E1-legacy-admission**.
3. **The 44/120 prompt-loss number overstates information loss.** The exact
   original is gone in 45 cells, but 43 of those still carry the task facts in
   a checkpoint (5 request copies, 38 values-only); only 2 end with neither the
   text nor the values. The two E1 "lost" cells still carried the values, so
   their 0/2 pass is not explained by absent facts.
4. **The mixed-origin authority bypass was real and is closed.** The old
   inputs let an assistant quote an old user decision next to its own newer
   statement and pass both the source and stale-source gates. The new origin
   rule refuses it.
5. **A 72-cell B0/E0/E1 design is frozen and not authorized.** It uses 12 new,
   offline-certified instances, the corrected `economic` admission, and a
   36/36 zero-request preflight. No provider call is granted by this round.

---

## 2. Baseline and method

- Worktree: `F:\Codex_Work_Space\DSH plugin\ef-c1-foundation` (linked worktree
  of `dsh-epistemic-fold`), branch `chore/ef-c1-evaluation-foundation`.
- Baseline commit: `34af295`; PR #5 open against `rc38-mechanism-validation`.
- Baseline artifact: `eval/r2/out/baseline.json`.
- The R1 240-cell archive is unchanged. The post-R1 evidence is packaged
  incrementally in `EF_R2_RESEARCH_ARCHIVE` (50 valid cells + 8 invalid
  negative-evidence cells, 787 files), verified on `F:` and `E:`.

Evidence levels used throughout:

| Level | Meaning |
|---|---|
| verified | commit record plus a verified bundle (EF), or the live event log |
| inferred | report/error/orphan bundle, link by order |
| unverifiable | not enough evidence; never promoted to a pass |

---

## 3. WP0 — baseline and incremental archive

`eval/r2/baseline.mjs` records the git/PR state and the numbers this round
argues from. It also audits the configuration divergence:

| Fact | Value |
|---|---|
| E1 cells / pass | 24 / 18 |
| E1 attempts | 42 |
| E1 commits | 11 |
| E1 failures | 31 |
| Unique E1 error strings | 31, all `summary is not smaller than the shadowed content` |
| Framed tokens (N) | 189–504 |
| Shadowed tokens (M) | 58–207 |
| Bundle files / commit records | 42 / 11 |
| Cells with orphan bundles | 15 |
| `DEFAULT_LEAF_ADMISSION` | `legacy` |
| E2E host passes `leafAdmission` | no |
| Shipped tiers setting `economic` | 3 |

`eval/r2/archive-incremental.mjs` copies only the post-R1 campaigns:
`e2e-t10-retest-1` (10), `e2e-prompt-pilot-2` (8),
`e2e-prompt-rerender-1` (8), `e2e-prompt-confirm-1` (24), plus the invalid
`e2e-prompt-pilot-1` (8, zero requests) as negative evidence. It creates a git
bundle, scans every text file (0 credentials), writes `SHA256SUMS`, and leaves
a repository pointer at `eval/r2/out/research-archive-r2.json`. Both the
primary copy and the `E:` copy verify 787/787.

---

## 4. WP1 — the Compaction Witness

`eval/e2e/src/witness.mjs` separates four facts that the old harness collapsed:

```
attempt    a compaction/start, regardless of outcome
produced   a summary and/or a durable bundle exists
committed  a surface replacement landed (replacement event or commit record)
delivered  a later PRIMARY request carried the checkpoint body
```

`compaction/end` is a closure marker, not the commit point. A missing end does
not erase a replacement that landed; an open attempt with no error is not a
fold.

The contract suite (`eval/r2/contracts/witness-contract.mjs`) covers seven
scenarios over real `FileBundleStore` files and synthetic event logs:

1. an economic refusal with no attempt;
2. a rationale call that fails while the fallback body commits;
3. a durable bundle the shrink check refuses before replacement;
4. two folds where the first checkpoint leaves the surface;
5. a fold after the last primary request (no delivery claim);
6. root/leaf/basic, each with its own commit evidence;
7. T5's two real commits plus one refusal.

**30/30 checks pass.** The artifact is `eval/r2/out/witness-contract.json`.

Reconstructing the 12 campaigns / 290 cells (`reconstruct-witnesses.mjs`):

| Metric | Count |
|---|---|
| attempts | 753 |
| committed | 673 |
| refused | 62 |
| aborted | 6 |
| unverifiable | 12 |
| verified / inferred / unverified attempts | 631 / 110 / 12 |
| legacy folds (`error === null`) | 685 |
| cells where legacy folds ≠ witness commits | 12 |

The 12 discrepancies are the silent-success class: an attempt opened and
closed with no error but produced no summary. The old analyzer counted it as a
fold. The witness calls it `unverifiable`, not failed.

Historical limits: an archived failed attempt is linked to its orphan bundle by
order (`inferred`); Basic has no EF bundle and no per-attempt delivery evidence
in the archive. Neither is upgraded to `verified`.

---

## 5. WP2 — the 31 E1 failures

`eval/r2/out/rationale-failure-attribution.json` joins each attempt to its
auxiliary call, its orphan bundle, the commit record and the error text.

| Fact | Value |
|---|---|
| E1 attempts | 42 |
| committed | 11 |
| refused | 31 |
| refusal reason | `shrink-refusal` (31/31) |
| auxiliary finish kinds | `stop` (31/31) |
| provider / bundle / surface errors | 0 |
| state-only body | 12 estimated tokens (every failure) |
| span | 58–207 tokens |
| checkpoint body | 189–504 framed tokens |
| body/span ratio | min 1.23, median 4.14, max 8.00 |
| failed-call cost | 7,083 input / 7,890 output |
| first-attempt failed calls | 15 calls, 3,573 / 3,649 |
| repeated failed calls | 16 calls, 3,510 / 4,241 |

Every failure paid for a rationale call that was never delivered. The failed
output is **47.2% of E1's total output tokens**.

### 5.1 Why the span was tiny

The `state-only` body is only the marker (12 tokens). The rationale is the
excess, not the structured state. A pre-call guard that compares the state-only
body with the span would not refuse a single one of the 31 attempts: a shorter
rationale could have committed. **A pre-call shrink guard is not justified.**

The retries are not uniformly futile either. Fourteen cells retried; two
committed on a later attempt:

| Cell | First span | Later span | Outcome |
|---|---|---|---|
| T9-s1-E1-r2 | 207 | 9,163 | committed |
| T10-s1-E1-r1 | 200 | 9,420 | committed |

A blanket retry suppression would lose those two commits. A refusal cache keyed
on the exact span seqs is a candidate, but the archive does not retain the
failed attempts' span seqs, so its effect cannot be measured here. **No retry
suppression is implemented.**

### 5.2 The configuration chain

- `src/config/policy.ts` defaults `leafAdmission` to `legacy`.
- `eval/e2e/src/host.mjs` passes `mode`, `semanticMode` and the R1 flags, but
  not `leafAdmission`.
- `src/config/preset.ts` sets `leafAdmission: economic` in economy, balanced
  and quality.

So the E1 arm is not the shipped tier. The economic admission prices the
**widest legal span with retain 0**, while the executor folds the span left
after `spec.retainTokens`; whether economic admission would have refused these
specific executed spans is a hypothesis, not a measured result. The next
preflight must check the **executed** span (WP6).

### 5.3 Decision

- No production code change in WP2.
- Do not lower the 16,384 rationale budget and do not tune the prompt.
- The next live design pre-registers `leafAdmission: economic` and verifies the
  executed fold span in a zero-request preflight.

---

## 6. WP3 — active-task delivery

The legacy metric used a 400-character preview and only the first and last
primary request. It is reproduced exactly: **44/120**.

The re-certification uses message digests for exact matching and full message
bytes where captured (194 cells; 96 older cells are `preview-only` for prefix
and containment checks).

| End-of-continuation delivery | Confirm cells |
|---|---|
| Original task message present | 75/120 |
| Original exact lost | 45/120 |
| Checkpoint carries the request text | 5 |
| Checkpoint carries the task values only | 38 |
| Checkpoint present, neither request nor values | 2 |
| Nothing visible | 0 |
| Task values unavailable | 2/120 |

By arm:

| Arm | End original | Checkpoint copy | Values only | Neither | Values unavailable |
|---|---|---|---|---|---|
| E0 | 12 | 0 | 12 | 0 | 0 |
| E0-G | 12 | 3 | 9 | 0 | 0 |
| E0-L | 15 | 1 | 7 | 1 | 1 |
| E0-LG | 14 | 1 | 8 | 1 | 1 |
| E1 | 22 | 0 | 2 | 0 | 0 |

The E1 prompt-loss covariate is reproduced by the legacy and exact metrics
(0/2 pass with the exact message lost, 18/22 with it visible). But the two
E1 exact-loss cells still carried the task values: **values unavailable 0/24**.
The 0/2 pass rate is therefore not explained by the facts disappearing; n=2,
so it is a description, not an effect.

**Limitation:** values-only proves the task facts survived, not that the
instruction wording or its constraints did. The two values-unavailable cells
(T2-s2-E0-L-r2 and T2-s2-E0-LG-r2) are the only cases where the earlier
"prompt lost" label coincides with actual information absence.

---

## 7. WP4 — ITT, transaction reliability, continuity and cost

The ITT reproduction matches EF-R1 exactly (`matchesR1: true`), including the
excluding-T10 McNemar values (E1 vs E0 p=0.0574, E0-LG vs E0 p=0.0703).

| Arm | ITT pass | Attempts | Committed | Refused | Pass with commit | Pass without commit | Delivered |
|---|---|---|---|---|---|---|---|
| E0 | 9/24 | 54 | 54 | 0 | 9 | 0 | 54 |
| E0-L | 15/24 | 51 | 48 | 0 | 15 | 0 | 48 |
| E0-G | 15/24 | 72 | 71 | 0 | 15 | 0 | 71 |
| E0-LG | 16/24 | 62 | 62 | 0 | 16 | 0 | 62 |
| E1 | 18/24 | 42 | 11 | 31 | 9/11 | 9/13 | 11 |

The committed/no-fold split is **descriptive**: the cells were not randomized to
commit or refuse. The refusal is a property of the span and the rationale body.

All 11 committed E1 checkpoints were delivered to a later primary request. In
T2/T4, E1 committed 8/8, delivered 8/8, carried both probes in 8/8 and passed
8/8; E0 passed 1/8. This is a genuine post-fold result, not an ITT estimate and
not a product-level causal claim.

Cost ledger (`eval/r2/out/cost-ledger.json`) reconciles with the campaign
budget:

| Arm | Requests | Input | Output | Aux calls | Failed calls |
|---|---|---|---|---|---|
| E0 | 83 | 678,175 | 10,569 | 0 | 0 |
| E0-L | 77 | 842,370 | 9,963 | 0 | 0 |
| E0-G | 145 | 919,738 | 19,764 | 0 | 0 |
| E0-LG | 113 | 967,562 | 15,937 | 0 | 0 |
| E1 | 96 | 295,420 | 16,727 | 42 | 31 |

The per-cell output cap is 20,000; the rationale reservation is 16,384 (81.9% of
the cap). Observed single-request output stayed far below either bound, but the
reservation is a latent ledger risk and is recorded.

No USD price is invented.

---

## 8. WP5 — mixed-origin authority closure

The bypass:

```
old user decision (seq 1)
    assistant statement (seq 2)
evidence: [old user quote, assistant statement]
old sourceAuthority -> 'user'      (a user message was present)
old latestDecisionSeq -> 2         (the assistant message was newer)
target user decision at seq 1
=> source gate passes, stale-source gate passes, replacement allowed
```

`decisionOriginOf` now takes the **newest decision-capable citation** as the
origin. The same fixture is:

- old inputs: `mayRetire` allowed;
- new validator: `sourceAuthority: assistant`, planner withheld,
  `insufficient-source-authority`;
- `AnchorService.declare` derives the producer from raw events, refuses a
  supplied label that disagrees before the append, and refuses an assistant
  declare at an occupied user coordinate;
- a later tool/system event cannot refresh an old user quote
  (`latestDecisionSeq` only counts decision-capable refs).

`tests/ef-r2-mixed-origin.spec.ts` has 12 tests, including the legit user
revision, assistant→assistant, user→assistant, old-user-only stale refusal,
supplied-label mismatch, occupied-coordinate refusal, later non-decision
refresh, origin unit cases and mechanical replay. The before/after matrix is
`eval/r2/out/authority-closure.json`. No model-callable tool or command calls
`AnchorService.retire`; it remains a privileged internal API.

**Limitation:** the rule is conservative. A user decision that cites a newer
assistant restatement is classified by that restatement and may be refused.
Refusal is safe; the false-negative direction is recorded, not hidden.

---

## 9. WP6 — the frozen 72-cell design (not authorized)

`eval/r2/out/live-design-r2.json` and
`eval/e2e/out/manifest-e2e-r2-live-1.json` freeze:

- 6 archetypes × 2 new instances × {B0, E0, E1} × 2 replicates = 72 cells;
- 12 new instances under `eval/e2e/tasks-r2/`, none of them a T7–T10 rerun;
- config for E0/E1: `leafAdmission: economic`, `rootPolicy: economics`,
  `framingMode: legacy`, `semanticContinuity: off`;
- a proposed envelope (72 cells, 2,000 HTTP attempts, 20M input, 1.5M output,
  6 h), **not granted**;
- `executionAuthorized: false`, `authorizationState: 'not-requested'`.

Offline certification: 12/12 instances fail initially, pass with the reference,
fail with the counterfactual, and seed above the 8,192-token threshold
(25,317–36,874 tokens).

Zero-request preflight: **36/36 cells pass**, 0 requests. The scripted adapter
answers the compaction/rationale prompts and writes the reference files; the
preflight proves wiring, a legal span, a commit and a later-request delivery,
not model behaviour. T16 reaches two committed folds in both arms.

The first preflight attempt failed 24/36. The cause was a fixture property, not
a host bug: a single long log was retained verbatim because the retained tail
crossed 614 tokens at that log, leaving only a tiny span before it. Adding a
second long observation (and a second stage for T16) made the first log the
span a fold selects. This is the same tiny-span mechanism WP2 measured, now
caught before a live run instead of after one.

---

## 10. Gates

| Gate | Status | Evidence |
|---|---|---|
| R2-G0 | pass | baseline, R1 pointer, verified R2 archive |
| R2-G1 | pass | witness contract 30/30; 290 cells reconstructed |
| R2-G2 | pass | 31/31 shrink refusals; 0 unexplained |
| R2-G2.5 | pass | no production fix; guard and suppression not justified |
| R2-G3 | pass | 44/120 reproduced; 45 exact lost; 2 values unavailable |
| R2-G4 | pass | cost ledger reconciles; 42 calls; 16,384 reservation |
| R2-G5 | pass | old allowed → new refused; 12 tests; retire not model-callable |
| R2-G6 | pass | supported lane on `4af0eea` (run 42804489967); the master probe failed as expected and is non-blocking |
| R2-G7 | pass | EF_R2.md, claims complete, live unauthorized |

`eval/r2/out/gate-status.json` is generated by `eval/r2/gates.mjs`. G6 is set
from `EF_R2_CI_STATUS` after the supported-lane run.

---

## 11. What changed in the EF-R1 reading

| EF-R1 statement | EF-R2 refinement |
|---|---|
| E1 had 11 successful and 31 failed folds | 42 attempts, 11 commits, 31 shrink refusals; the 31 calls were paid and never delivered |
| E1 is the economy arm | E1 ran `leafAdmission: legacy`; the shipped tiers use `economic` |
| 44/120 cells lost the task prompt | 45 exact losses; 43 still carry the task facts (5 copies, 38 values-only); only 2 have neither |
| Task-prompt loss is a confound | The E1 lost cells still had the values; the covariate is reproduced but is not an information-loss explanation |
| T2/T4 E1 8/8 | Committed 8/8, delivered 8/8, probes 2/2; a post-fold result, not a product claim |
| E1's 18/24 ITT | Unchanged; it includes 13 no-fold cells (9 pass) and 11 committed cells (9 pass) |

Unchanged: the 120-cell ITT numbers, the T10 exclusion, the finding that no L/G
arm is significant at 0.05 after excluding T10, and the Deployment Hold.

---

## 12. Limits

- One model, one route, one machine. No product-level claim.
- The 120-cell E1 arm is not the shipped tier; the WP6 design corrects the
  config but has not been run.
- The post-R1 archive's 50 new cells are valid; the 8 invalid cells are retained
  only as negative evidence.
- Historical EF failures link orphan bundles by order; Basic has no per-attempt
  delivery evidence.
- The 96 pre-confirm cells lack full messages; their exact digests are usable,
  but prefix/containment checks are `preview-only`.
- Values-only delivery proves facts, not instruction wording.
- No verifiable per-token price; the ledger is tokens, requests, bytes and wall
  clock.
- The 72-cell design is frozen and uncertified by a live run. The preflight is a
  scripted wiring test.
- The local supported lane has one `rc7-inplace-drift` failure because the
  vendored DSH reference tree is not present locally; CI checks out the pinned
  DSH and is the gate. The other local failures are in the workflow's
  non-blocking historical-probe files.
- The candidate tarball was built against the locally installed DSH (rc7); the
  pack reports the expected preset drift, and the 13/13 smoke is construction
  and composition only. CI pins rc2.

---

## 13. Decisions

- Semantic Active: **Deployment Hold (unchanged)**.
- Rationale: no prompt change, no budget change, no default change.
- Locator / Guard / Re-render: research branches; not added to the product
  arms.
- Mixed-origin authority: closed in the supported source; conservative
  false-refusal direction recorded.
- Live confirmation: a new grant is required, bound to
  `manifest-e2e-r2-live-1.json`; the R1 envelopes remain closed.

---

## 14. Reproduction

```bash
node eval/r2/baseline.mjs
node eval/r2/archive-incremental.mjs
node eval/r2/contracts/witness-contract.mjs
node eval/r2/reconstruct-witnesses.mjs
node eval/r2/attribute-rationale.mjs
node eval/r2/task-delivery.mjs
node eval/r2/causal-reanalysis.mjs
node eval/r2/cost-ledger.mjs
node eval/r2/mixed-origin-authority.mjs
node eval/r2/generate-tasks-r2.mjs
EF_E2E_TASKS_DIR=eval/e2e/tasks-r2 \
  EF_E2E_CERTIFICATION_OUT=eval/r2/out/task-certification-r2.json \
  node eval/e2e/src/certify-tasks.mjs
node eval/r2/live-preflight.mjs
node eval/r2/freeze-live.mjs
node eval/r2/evidence-claims.mjs
EF_R2_CI_STATUS=success node eval/r2/gates.mjs
```

The archive commands need the external `EF_R2_RESEARCH_ARCHIVE` directory; the
repository carries only the pointer and hashes.

---

## 15. Evidence

`eval/r2/out/evidence-claims.json` is the round's claim registry. It names one
artifact and one limitation per claim and never upgrades an unverifiable cell.
The EF-R1 registry is unchanged.
