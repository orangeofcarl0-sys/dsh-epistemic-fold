# R33 — Dataset

**Dataset ID:** `r33-semantic-continuity-v1`
**Manifest digest:** `2666e70f0cdba13bc3c756ff086b3566f51c0a9b595ecd9495859f73c0c21f26`
**Cases:** 17
**Frozen:** before any arm or model run; `eval/r33/manifest.json` is authoritative.
**Loader:** `eval/r33/src/dataset.mjs` (`loadDataset`, `verifyFrozen`).

The digest covers each case's metadata, transcript, gold, workspace files,
action trees, and hidden checker. Editing any of them invalidates the manifest
and `npm run eval:r33-verify` fails.

---

## 1. Risk-class coverage

| Class | Cases | What the pair/controls test |
|---|---|---|
| Persistent constraint | A1, A2 | Same task and workspace; the correct API decision flips with the early requirement. |
| Decision override | B1, B2 | A later user requirement overrides an adopted decision, or the alternative is explicitly rejected. |
| Negative knowledge | C1, C2 | A tool-proven failure suppresses a retry; a later fix retires the rejection instead of freezing it. |
| Validation boundary | D1, D2 | Written / run / verified; a verified claim needs a run or a carried evidence reference. |
| Cross-phase dependency | E1, E2 | Phase 2 consumes the exact phase-1 artifact named only in history. |
| Authority & scope | F1, F2, F3, F4 | Tool text vs user authority; same `subjectKey` on two scopes; more facts than one fold accepts. |
| Retrieval trigger | H1 | The fact exists in history but not in the checkpoint; the agent must notice or retrieve. |
| History-independent | G1, G2 | Ordinary README-specified tasks: the null arm should pass, so Active must not add cost or harm here. |

Five counterfactual pairs (A, B, C, E, F) plus seven diagnostic singles. This
is a first-stage diagnostic set; it is not the 12–24-pair final scale the brief
envisions.

## 2. Case inventory

| ID | Class | Pair | Gold facts | Correct / forbidden action | History |
|---|---|---|---|---|---|
| A1 | persistent-constraint | A:keep | 1 constraint | keep-api / rename-api | dependent |
| A2 | persistent-constraint | A:remove | 1 constraint | rename-api / keep-api | dependent |
| B1 | decision-override | B:outbox | 2 decisions | use-outbox / use-memory | dependent |
| B2 | decision-override | B:memory | 1 decision, 1 rejection | use-memory / use-outbox | dependent |
| C1 | negative-knowledge | C:lost-events | 1 rejection, 1 objective | poll / fs-watch | dependent |
| C2 | negative-knowledge | C:fixed | 1 finding, 1 objective | fs-watch / poll | dependent |
| D1 | validation-boundary | — | 1 finding | report-unverified / trust-history | dependent |
| D2 | validation-boundary | — | 1 finding | carry-verification / claim-unverified | dependent |
| E1 | cross-phase-dependency | E:v2 | 1 decision | use-v2 / use-v1 | dependent |
| E2 | cross-phase-dependency | E:v1 | 1 decision | use-v1 / use-v2 | dependent |
| F1 | authority-scope | F:keep | 1 constraint | keep-legacy / delete-legacy | dependent |
| F2 | authority-scope | F:remove | 1 constraint | delete-legacy / keep-legacy | dependent |
| F3 | authority-scope | — | 2 scoped constraints | scoped / unscoped | dependent |
| F4 | authority-scope | — | 13 constraints | apply-all-13 / apply-0 | dependent |
| G1 | history-independent | — | 1 objective | implement / wrong | independent |
| G2 | history-independent | — | 1 objective | implement / wrong | independent |
| H1 | retrieval-trigger | — | 1 finding | use-eu / use-us | dependent |

## 3. Gold model

Each fact carries:

```json
{
  "factId": "A1-legacy-api",
  "kind": "constraint",
  "subjectKey": "api-compatibility",
  "scope": { "branch": "release" },
  "sourceRefs": [0],
  "quote": "keep the existing loadConfig(path) string form working",
  "statement": "The loadConfig(path) string form must remain backward compatible.",
  "criticality": "high",
  "current": true,
  "visibleNeedle": "loadConfig(path) string form",
  "expectedBehavior": "Keep the string form working and add the object form.",
  "oracleEvidence": ["optional additional verbatim quotes"]
}
```

* `criticality` was assigned from task dependence before the arms ran, not from
  whether a writer extracted it.
* `quote` must be verbatim in the cited transcript entry. The schema refuses a
  case whose quote is not there.
* `current: false` means the fact must not remain the effective state (for
  example, a withdrawn decision). `current: true` includes current negative
  knowledge (a rejection that still governs action).
* `scope` participates in identity, so two branches may hold the same
  `subjectKey` (F3).
* `oracleEvidence` supplies the additional quotes a fact needs when one quote
  alone does not ground its kind (for example, C1's rejection needs the
  assistant's decision and the tool's measurement).

## 4. Counterfactual construction

For A, B, C, E and F:

* the initial workspace file map is **identical** across the pair;
* the follow-up task text is **identical**;
* the decisive historical fact differs (A1 keeps the legacy API, A2 removes it;
  B1 overrides to an outbox, B2 rejects it; C1 rejects `fs.watch`, C2 records
  that it was fixed; E1 names schema-v2, E2 schema-v1; F1 keeps the adapter,
  F2 removes it);
* the correct action differs, so a single "do something reasonable" response
  cannot satisfy both.

These properties are asserted in `tests/r33-dataset.spec.ts`, not left to
review.

## 5. Hidden checkers and workspaces

Each case has:

* `workspace/**` — exactly the files the follow-up agent sees;
* `actions/<name>/**` — files one scripted action applies (the live agent edits
  the workspace directly);
* `check.mjs` — an independent checker written **outside** the workspace and
  run with `R33_WORKSPACE` pointing at it. It prints one `R33_RESULT {json}`
  line with named checks.

The checker is the task acceptance. A run whose checker crashes or prints no
result is `checker-invalid`, not a task failure.

## 6. No-gold leakage

The schema refuses a history-dependent case if any workspace file contains a
gold quote or `visibleNeedle`. That is why H1's visible test only checks that
the region is a string: the value itself exists only in the frozen transcript.
The hidden checker is never copied into the workspace, and the gold block is
only used by the O2 arm, which is explicitly an oracle.

## 7. Frozen files and reproduction

```bash
npm run eval:r33-verify   # manifest matches every case; exits non-zero on drift
npm run eval:r33-freeze   # authoring tool: rebuild cases + manifest
```

`eval/r33/build-cases.mjs` is a one-time authoring tool; the generated case
directories and manifest are the committed artifacts. The manifest, not the
generator, is what the runner verifies.

## 8. Known limitations

* Five pairs and seven singles are enough to diagnose the pipeline, not to claim
  population-level effect sizes.
* The micro-repositories are synthetic and small. They make acceptance exact and
  reproducible; they do not represent large codebases.
* The gold set is closed-world. A claim outside it is `unsupported` by
  definition; a real deployment would need a broader review process.
* The scripted writer's proposals are frozen model *outputs*, not model
  behavior. Only the live arm can measure extraction quality.
* H1's offline arms cannot ask a question; the live `recall` tool is the
  behavior under test.
