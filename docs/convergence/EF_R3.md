# EF-R3 — Confirmatory Closure & Product Policy Selection

**Status:** offline closure complete; live completion and product lane are frozen designs only.
**Baseline:** `4affdee8a1c272bcbaa43fba4f842bf4ab8f87aa` on `chore/ef-c1-evaluation-foundation`.
**PR:** [#5](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/pull/5), open, research integration only.
**Live calls in this round:** none. The only new run is a scripted self-test with 0 provider requests.

## 1. What EF-R2 left, and what R3 corrects

EF-R2 delivered the Compaction Witness, the 31-attempt shrink-refusal attribution, the full-message delivery re-certification, the mixed-origin authority closure, an 18-cell live pilot and a 54-cell live confirm that stopped after 23 valid cells. R3 does not re-litigate those results. It closes four measurement defects and one product-truth defect that the R2 artifacts exposed:

1. **The confirm ledger double-counted a retried transport failure.** `eval/r2/merge-confirm.mjs` subtracted both excluded attempts from the cell count, but `T13-s1-B0-r2` failed once and then succeeded on the resume. The correct ledger is 23 valid + 1 unresolved + 30 never-started = 31 cells with no valid outcome, not invalid 2 / unexecuted 29.
2. **“Valid” was doing three jobs.** A checker result, a readable compaction exposure and a complete usage ledger are different eligibility axes. Three confirm cells and three pilot cells have partial usage; only 5/7 confirm pairs and 4/6 pilot pairs are cost-valid.
3. **The two transport failures were not classified.** Both are T13/B0. The first cell later succeeded with a comparable 75,603-character summary; the second remains unresolved. The archived trace cannot distinguish socket reuse from a transient local route reset.
4. **Admission and execution price different spans.** `admitLeafEconomically` uses `selectLeafSpan(..., 0, ...)` — the widest legal span — while execution uses `selectLeafSpan(..., spec.retainTokens, ...)`. The gap was not measured.
5. **The manifest and the executed treatment differed.** The R2 manifest declared `rationaleHintTokens: 800`, but `eval/e2e/src/host.mjs` did not forward it. E1 ran the economy preset's 400. The current economy tier also still claimed RC1.3 “measured parity”, although RC1.3 measured the explicit `semanticMode: none` profile.

## 2. R3-A — the ledger and the transport

### 2.1 Unique Cell ledger

`eval/r3/out/live-confirm-reconciliation.json`, `attempt-ledger.json`, `cell-ledger.json`.

| Quantity | Value |
|---|---|
| Planned | 54 |
| Valid | 23 |
| Unresolved (executed, no valid result) | 1 — `T13-s2-B0-r1` |
| Never started | 30 |
| No valid outcome | 31 |
| Executed attempts | 25 (23 valid + 2 transport-failed) |
| Unique cells started | 24 |
| Missing by template | T13 4, T14 9, T15 9, T16 9 |

`T13-s1-B0-r2` is one valid cell: its first attempt is transport-failed, its resume attempt is valid. The old `live-route-incident.json` remains byte-identical; `corrects[]` records the arithmetic change (`invalidCells 2→1`, `unexecutedCells 29→30`, `noValidOutcomeCells 31`). The historical merged results are not rewritten.

The 19-check ledger contract (`eval/r3/out/ledger-contract.json`) covers failed-then-valid, failed-unresolved, duplicate-valid, partial-usage, never-started and manifest/cell mismatch.

### 2.2 Transport diagnosis

`eval/r3/out/transport-diagnosis.json`, `transport-contract.json`.

- `T13-s1-B0-r2` attempt 1: summary 75,603 message characters, `LIVE_TRANSPORT`, 6 ms. Resume: the same 75,603-character summary, `stop`, 5,858 ms.
- `T13-s2-B0-r1`: summary 75,608 characters, `LIVE_TRANSPORT`, 10 ms. No later valid attempt.
- The failed payloads are **not** larger than the successful B0 summary range (successful max 149,073 characters). The payload-size hypothesis is weakened.
- Both failures are immediate (`≤100 ms`) and both are fetch-level, not HTTP-status failures. The route-transient hypothesis is supported, but n=2 and there is no socket identity, keep-alive state or real per-attempt HTTP count in the archive.
- A localhost mock contract (13/13) proves that an immediate reset becomes `LIVE_TRANSPORT` with no usage, a mid-response reset is never a silent empty success, and partial usage is a valid task outcome with `costValid=false`.

No further live call was made. The representative health probe (`eval/r3/out/transport-health-probe.json`, 16 requests, 4 long-payload profiles) is a design with `executionAuthorized:false`.

## 3. R3-B — exact-span economics

### 3.1 The mechanism

`src/policy/fold-economics.ts:157` calls `selectLeafSpan(session, measurement, 0, ...)`. `retainTokens=0` does not mean “retain nothing”: `src/fold/leaf-policy.ts:90-96` always consumes the last node before it can break, so admission prices the widest legal span any retention setting could produce. `src/fold/engine.ts` then executes `selectLeafSpan(..., spec.retainTokens, ...)`, whose span is a suffix of the admitted one.

The new opt-in probe (`src/policy/leaf-span-probe.ts`) records both spans on the same measurement, the checkpoint estimate each implies, and after a fold the actual checkpoint cost and surface delta. It never changes a verdict, a span or an exception path. The E2E harness enables it; the product default is off.

### 3.2 Deterministic matrix

`eval/r3/out/span-economics.json`: 60 keyless cases (admission economic/legacy × retain 0.04/0.16/0.24 × framing legacy/system-dedup × checkpoint 180/300/500/1000/2000 tokens).

| Retain ratio | Retain tokens | Median widest→executed gap |
|---|---|---|
| 0.04 | 535 | 516 tokens |
| 0.16 | 2,141 | 2,064 tokens |
| 0.24 | 3,212 | 3,096 tokens |

At the default reclaim floors (600 tokens, MRR 0.25) the large spans clear both sides: 0 false admissions. Setting the floor one token above the executed-span reclaim flips the same gap: **3/3 floor-sensitivity cases are `admission=true`, `execution=false`**. This is a deterministic span mismatch, not a model failure.

The probe is observational: the R3 tests show the widest span ≥ the executed span, retain 0 equality, execution-null while admission sees a span, and no mutation of the session/measurement. A scripted E2E self-test reconciles actual checkpoint tokens (20) with the surface delta (7,087) and the executed span (7,107).

R2 live reports predate the probe, so their exact-span economics is **unavailable, not zero**. The probe is for future runs and for the deterministic matrix.

### 3.3 Config preflight and the 800/400 drift

`eval/r3/out/config-preflight.json` (historical) reproduces the R2 host: E1 declared 800, effective 400. The drift affects 18 confirm E1 cells and 6 pilot E1 cells. `config-preflight-forwarded.json` passes after `host.mjs` was extended to forward every declared key. The fixed host is a future-run guarantee; the historical cells are not re-run.

The R2 E1 treatment is therefore **not** “economy preset + 800 hint”. It is:

```
economy preset, semanticMode rationale, rationaleHintTokens 400,
leafAdmission economic, rootPolicy economics, framingMode legacy,
retainRatio 0.04, 16k window, semanticContinuity off
```

A completion that changes the hint to 800 or the framing to `system-dedup` is a different treatment and must be a new campaign.

## 4. R3-C — quality, cost, reliability, and the product decision

`eval/r3/out/product-frontier.json` / `.md`. Pilot and confirm are separate instance sets and are not pooled.

### 4.1 Paired E1 − B0

| Campaign | Pairs | Both | Neither | E1 only | B0 only | McNemar p | Recorded pass | Requests | Uncached input | Cache read | Output | Cost-valid pairs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Pilot | 6 | 5 | 0 | 1 | 0 | 1 | +1 | −30 | −204,950 | +43,904 | −25,577 | 4 |
| Confirm | 7 | 4 | 3 | 0 | 0 | 1 | 0 | −28 | +169,138 | −186,496 | −18,954 | 5 |

The user-supplied deltas are reproduced exactly. They are **recorded**, not cost-complete. The cost-valid subset is smaller and directionally different (pilot input −85,646; confirm input +141,527), which is why both tables are reported.

### 4.2 Eligibility and bias

- Confirm: 23 valid, 1 unresolved, 30 never-started; 3 cost-invalid valid cells (`T12-s2-B0-r1`, `T13-s1-E1-r2`, `T13-s2-E1-r2`); 18 E1 cells with the 800/400 config mismatch.
- Pilot: 18 valid; 3 cost-invalid cells (`T15-s1-B0-r1`, `T16-s1-B0-r1`, `T16-s1-E0-r1`).
- T14, T15 and T16 have **no valid confirm cells**. The 23-cell subset is task-type biased, not a random 23 of 54.

### 4.3 Stress lane vs product preset

| Lane | Window | Retain | Framing | Hint | Data |
|---|---|---|---|---|---|
| 16k stress | 16,384 | 0.04 | legacy | 400 effective (800 declared) | observed |
| economy | product-dependent | 0.16 | system-dedup | 400 | not executed |
| balanced | product-dependent | 0.24 | system-dedup | 800 | not executed |
| quality | product-dependent | 0.24 | system-dedup | 1600 | not executed |

The R2 live lane is a stress lane. It cannot support a product-tier claim.

### 4.4 Decision

`eval/r3/out/product-decision.json`: **no product candidate; Deployment Hold remains.**

Reasons: the confirm is partial and task-type biased; the paired checker difference is 0 in the confirm and +1 in the pilot; the recorded economics direction is unstable; cost validity is incomplete; the stress treatment is not the shipped preset; no product-representative lane has run; no USD price is recorded.

This is a decision not to promote on current evidence, not a claim that E1 is ineffective.

## 5. Preset evidence truth

`src/config/preset.ts` is corrected at the metadata level only. No tier value or product default changed.

- The current economy, balanced and quality tiers are all `evidence: 'hypothesis'` for their effective configs.
- Economy carries `evidenceProfile: 'rc1.3-zero-llm-economy (semanticMode: none)'`.
- The evidence detail says RC1.3 measured the explicit zero-LLM profile and that the result does not transfer to the current rationale-bearing tier.
- The effective-config report prints `measured profile: ...` next to the hypothesis, so a user can see what was measured and what was not.

`eval/r3/out/preset-evidence.json` records the claim, the profile and the current config. `tests/r3-preset-evidence.spec.ts` pins it.

## 6. Freeze: completion and product lane

### 6.1 Confirm completion

`eval/e2e/out/manifest-e2e-r3-confirm-completion-1.json`, `eval/r3/out/completion-design-r3.json`.

- 31 missing cells: 1 unresolved + 30 never-started.
- Pinned to the **effective R2 config** (hint 400, legacy framing, retain 0.04, 16k), so the new cells are comparable with the 23 valid ones.
- Execution order interleaved across T13–T16; the original order is retained in the manifest.
- New manifest SHA-256; `executionAuthorized: false`; `authorizationState: 'not-requested'`.
- Prerequisite: a passing representative transport health probe under a new grant.

An 800-hint or shipped-preset run is a new campaign, not a merge.

### 6.2 Product-representative lane

`eval/r3/out/product-lane-design-r3.json`: 72-cell design (6 templates × 2 instances × B0/E0/E1 × 2 replicates), shipped economy/balanced/quality configs, proposed 32k first window, target 128k. No task set is frozen, no data exists, `executionAuthorized: false`. The R2 tasks need an offline exposure audit at the proposed window, or new instances.

## 7. Archive

`EF_R2_LIVE_RESEARCH_ARCHIVE`: 548 files, 46,853,151 bytes, 43 raw attempts (18 pilot + 25 confirm attempts), 23 valid confirm cells, 2 transport-failed attempts, 30 never-started cells. Credential scan: 0. Git bundle verified. SHA256SUMS verified on the primary archive and on the `E:` copy (548/548). The second copy is another local volume, not an off-machine backup.

The pre-live R2 archive remains the authority for the earlier 50 valid cells and 8 invalid records. No historical file was modified.

## 8. Gates

`eval/r3/out/gate-status.json` (regenerated after CI):

| Gate | Status | Evidence |
|---|---|---|
| R3-G0 | pass | baseline 4affdee; 22 immutable R2 artifacts; archive and copy verified |
| R3-G1 | pass | 23/1/30/31 ledger; T13 4, T14 9, T15 9, T16 9; 19/19 contract |
| R3-G2 | incomplete | transport classified and contract 13/13; live stability not verified; health probe design only |
| R3-G3 | pass | 60-case matrix; median gaps 516/2,064/3,096; 3/3 floor-sensitivity flips; probe non-behavioral |
| R3-G4 | pass | user deltas reproduced; 3+3 cost-invalid cells; 5/7 and 4/6 cost-valid pairs |
| R3-G5 | incomplete | completion design 31 cells; confirm 23/54; no live authorization |
| R3-G6 | pass | historical 800/400 drift detected; forwarded preflight passes; stress/product separated; preset 3/3 hypothesis |
| R3-G7 | pass after CI | zero-live audit pass; claims 0 missing; supported CI lane |
| R3-G8 | pass | product decision no candidate / hold, with 8 reasons |

`incomplete` is not fail. R3-G2 and R3-G5 can only become pass under a new explicit live authorization; neither is promoted by assumption.

## 9. Limits and non-claims

- The confirm is partial. It is not a confirmatory result, and the pilot is not pooled with it.
- The valid confirm subset is task-type biased: T14–T16 have no valid cells.
- The 7-pair and 6-pair economics include cells with partial usage. The cost-valid tables are smaller. No usage is imputed.
- No USD price is recorded or claimed. Token-resource deltas are not a monetary comparison.
- One model (`deepseek-v4.1-flash`), one local route, one machine.
- R2 live reports predate the exact-span probe; their exact-span data is unavailable, not zero.
- The stress lane is not the shipped product preset. No product candidate is claimed.
- The transport diagnosis is a description of two failures, not a provider-level causal estimate.
- The completion and product-lane designs are frozen documents, not runs.

## 10. Reproduction

```bash
npm run build
npm run typecheck
npm test -- tests/r3-leaf-span-probe.spec.ts tests/r3-preset-evidence.spec.ts \
  tests/r3-span-economics.spec.ts tests/rc2-tiers.spec.ts tests/r4f-preset.spec.ts \
  tests/convergence-config.spec.ts tests/r2b-admission.spec.ts tests/fold-reachability.spec.ts \
  tests/fold-telemetry.spec.ts tests/ef-r2-mixed-origin.spec.ts

node eval/r3/baseline.mjs
node eval/r3/contracts/ledger-contract.mjs
node eval/r3/reconcile-confirm.mjs
node eval/r3/transport-diagnose.mjs
node eval/r3/contracts/transport-contract.mjs
node eval/r3/freeze-health-probe.mjs
node eval/r3/config-preflight.mjs --manifest eval/e2e/out/manifest-e2e-r2-confirm-1.json --historical
node eval/r3/config-preflight.mjs --manifest eval/e2e/out/manifest-e2e-r2-confirm-1.json --forwarded
node eval/r3/span-economics.mjs
node eval/r3/product-frontier.mjs
node eval/r3/preset-evidence.mjs
node eval/r3/freeze-completion.mjs
node eval/r3/freeze-product-lane.mjs
node eval/r3/zero-live-audit.mjs
node eval/r3/evidence-claims.mjs
EF_R3_CI_STATUS=success node eval/r3/gates.mjs
```

Archive verification:

```bash
node eval/e2e/src/verify-archive.mjs \
  --archive ../EF_R2_LIVE_RESEARCH_ARCHIVE \
  --pointer eval/r3/out/research-archive-r2-live.json \
  --out eval/r3/out/archive-verification-r2-live.json
```

## 11. Live boundary

The R2 envelopes are spent, and unused capacity is not permission. Any health probe, confirm completion or product-lane run requires:

1. a new explicit authorization bound to a new manifest SHA-256;
2. a route/model freeze;
3. a passing representative transport health probe;
4. a config preflight that compares every declared key with the effective config;
5. a stop-on-transport-failure rule with no automatic retry.

If the route cannot be qualified, the correct outcome is to keep the confirm partial and stop consuming, not to retry indefinitely.
