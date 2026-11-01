# R34 — Real-Model Results

Status: **no real-model result exists in this round.**

The live tier is `not-executed / blocked`: no explicit live authorization, no
resolved provider route, and no budget were supplied. **0 provider requests, 0
input tokens, 0 output tokens, 0 retries.** Every number below is either a
scripted-instrument result or a plumbing test, and is labelled as such.

## Layers

| Layer | Executed? | What it can prove |
|---|---|---|
| Scripted pipeline (offline arms) | yes, 144 rows | information delivery and validator/state behavior; not model quality |
| Live writer only | **no** | would measure real writer protocol/extraction |
| Live custom tool loop | **no** | would measure real continuation in THIS harness |
| Production DSH agent loop | **no** | would measure the product loop; not implemented this round |

Not one of these is merged into a single "accuracy".

## 1. Scripted pipeline — 144 rows

Dataset `r33-semantic-continuity-v2`, digest
`407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f`,
scorer v2. 17 cases × 8 arms + 8 FM-1 rows. The writer and the follow-up
decision are scripted; the folds, validators, journals, working-set compilers,
and hidden checkers are real.

| Arm | Valid | Task success | Damage | Process violations | Claim recall | Coordinate recall | Grounded precision | Source support | False normative | Current state |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 (native Basic, scripted) | 17 | 7 | 10 | 1 | — | — | — | — | — | — |
| B1 (EF off, scripted) | 17 | 7 | 10 | 1 | — | — | — | — | — | — |
| S (EF active, scripted writer) | 17 | **15** | **2** | 0 | 0.926 | 0.928 | 1.000 | 1.000 | 0.000 | 0.928 |
| O1 (oracle deltas, real runtime) | 17 | **16** | **1** | 0 | 0.993 | 0.995 | 1.000 | 1.000 | 0.000 | 0.995 |
| O2 (visible gold facts, current only) | 17 | **17** | 0 | 0 | — | — | — | — | — | — |
| OR (gold evidence quotes) | 17 | 17 | 0 | 0 | — | — | — | — | — | — |
| F (full transcript) | 17 | 17 | 0 | 0 | — | — | — | — | — | — |
| N (null memory) | 17 | 3 | 14 | 1 | — | — | — | — | — | — |
| FM-1 (false fact already visible) | 8 | 0 | 8 | 1 | 0.875 | 0.875 | 1.000 | 1.000 | 0.000 | — |

Task-level treatment comparisons:

| Baseline → treatment | Rescue | Damage | Both | Neither |
|---|---:|---:|---:|---:|
| B1 → S | **8** | **0** | 7 | 2 |
| B0 → S | 8 | 0 | 7 | 2 |
| S → O1 | 1 | 0 | 15 | 1 |
| O1 → O2 | 1 | 0 | 16 | 0 |
| N → S | 12 | 0 | 3 | 2 |
| B1 → O1 | 9 | 0 | 7 | 1 |

Cluster-aware paired bootstrap over families (12 clusters, exploratory):

```text
S  - B1   +0.471   [0.158, 0.750]
O1 - S    +0.059   [0.000, 0.200]
O2 - O1   +0.059   [0.000, 0.200]
```

This is a **pipeline** result: the scripted writer proposes the frozen deltas,
and the scripted follow-up acts on the visible context. It shows the delivery
contract can change an action, not that a real model will.

### What the two S failures are

- **H1**: the writer proposed 0 deltas. The checkpoint omits the region fact.
  O1 (oracle deltas) rescues the case; O2/F also pass. The failure is at the
  writer, not the fold or the follow-up action.
- **F4**: 13 release rules exceed the 12-delta validation capacity. S accepts
  12 and hits the limit; O1 also hits it, because the limit is in the runtime,
  not the writer. O2/F pass because they bypass the delta path. This is a
  capacity bottleneck, not a writer omission.

The R33 v1 scorer would have counted a same-coordinate counter-claim as correct.
v2 does not; the frozen v2 cases happen to contain no such counter-claim, so the
arm numbers are unchanged. The defect is pinned by deterministic tests
(`tests/r331-scoring.spec.ts`), not by rewriting old data.

## 2. Four-arm self-test — real host, scripted model

`node eval/r33/live.mjs --self-test` ran B1/S/O1/O2 over all 17 cases:
**68/68 valid, 68/68 task success**. This is a plumbing test, not a model
result. It proves:

| Arm | Writer calls | Accepted deltas | Committed state | Anchors | Attempts |
|---|---:|---:|---:|---:|---:|
| B1 | 0 | 0 | 0 | 0 | 103 |
| S | 17 | 30 | 17 | 58 | 103 |
| O1 | 17 (oracle) | 33 | 17 | 64 | 86 |
| O2 | 0 | 0 | 0 | 0 | 103 |

- S and O1 both traverse the real validator, planner, journal, working-set
  compiler, and fold.
- O1 replaces only the writer's proposal; when S ran first, it reuses S's
  handoff and is labelled `s-conditional`.
- Every checker executed; every row has a transcript-index → DSH event-seq map.
- The ledger saw 395 scripted attempts, 3,950 scripted input tokens, 3,950
  scripted output tokens, 0 unresolved reservations. These are **scripted
  adapter** figures, not provider usage.

## 3. Live writer-only — NOT EXECUTED

The entry exists (`--run` + a valid manifest), but no live authorization,
route, or budget was supplied. The gate returned `not-executed` with exit 3 and
made no request. A valid manifest with an absent route returns
`provider-unavailable` with exit 5 and still makes no request
(`tests/r331-live-writer.spec.ts`).

Therefore there is **no real writer protocol, extraction, false-normative, or
scope result** in this round.

## 4. Live custom tool loop — NOT EXECUTED

The loop is implemented and exercised only with a scripted adapter. In live
mode it would call the provider through the metered OpenAI-compatible adapter.
No real task success, constraint violation, obsolete revival, rejected retrial,
false verification claim, tool-call count, or recall trigger exists.

## 5. Production DSH agent loop — NOT EXERCISED

The live entry uses the custom text-JSON loop. It is not the production DSH
agent loop, and production `context_search`/`context_recall` was not used. The
report never presents the custom loop as the product loop.

## Verdict at this layer

```text
scripted pipeline       positive (delivery contract)
live writer             not executed
live continuation       not executed
production loop         not executed
real-model evidence     insufficient
```
