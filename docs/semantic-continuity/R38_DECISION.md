# R38-M0 — Decision

## 1. Answers

### A. Git and code

```text
base          7a2c974c479bc1286f172e9f7b203af92e22e629
branch        rc38-mechanism-validation
final HEAD    this handoff commit
worktree      clean
push          not performed
```

Production changes are limited to the WP1 safety layer:
`src/semantic/retirement.ts` (new), `plan.ts`, `validate.ts`, `types.ts`,
`src/fold/engine.ts`. Everything else is eval code, tests and docs.

R37-B/C/D evidence is untouched; the R37-B archive hash still matches.

### B. Relation authorization

A tool-origin finding **cannot** retire a user constraint. The block is in
`planCommit`, not in the validator: the claim is accepted, the retirement is
refused with `insufficient-authority`. An assistant decision is refused for the
same reason. A user revision at the same coordinate applies.

Different authorities and scopes:

```text
normative -> decision/empirical     allowed
decision  -> empirical              allowed
empirical -> normative/decision     refused
hypothesis-> anything above it      refused
any       -> another scope          refused (cross-scope)
```

`verified` is evidence status, not normative standing. It is not used in the
rank.

### C. Delta identity

The same claim with different `supersedes` targets has the **same** `deltaId`.
Claim identity is unchanged and historical anchor ids are byte-identical.

A separate revision identity lets a repeated claim with a new plan contribute
its operations: one declare, two retires. An exact repeat is still refused as
`duplicate`. Replay, restart and retry are deterministic; a double application
is detected by the commit-state digest, not silently accepted.

### D. Supersession completeness

Targets are classified as `previous-absent`, `already-retired`, `resolved`,
`sibling`, `cross-scope`, `ambiguous` or `unknown`.

- `unknown` and `ambiguous` **withhold** the delta; no declare, no retire.
- `cross-scope` and `insufficient-authority` keep the claim and drop the retire.
- `already-retired` and `previous-absent` are benign.

N5 is reproducible and detected: the incomplete revision leaves the rejected
outbox active and the auditor reports `stale-negative-knowledge`. The complete
revision clears it. Deterministic conflicts are separated from review
candidates; nothing is auto-retired.

### E. Task-aware selection

Yes, critical-fact coverage improves under budget pressure: 0/1 → 1/1 in the
B2 case. Negative knowledge is selected when the task depends on it. Unrelated
token cost falls (S0 115 → S1 99 content tokens; scope case 122 → 76). Stale
state is not silently promoted; scope mismatches are recorded explicitly.

The greedy case is fixed: the prefix selector breaks at B and drops C; the
task-aware selector skips B and keeps C.

### F. Archive recovery

Two of the five fixtures had a critical fact in the archive only (H1-v2 region,
S1-v1 timeout); both were recovered. A genuine miss and a descriptor-bound miss
receive different statuses (`not-found-in-checked-scope` vs
`coverage-not-assessed`). No query term is a substring of the answer. Cost is
2-3 operations and +22-25 tokens. State is never modified.

### G. Native integration

The overlay is delivered through `systemPrompt.context` → the DSH loop's
`runtime-context` user message. It is stable and replayable: two identical
steps produce one snapshot; a task change produces a second; a real JSONL
resume delivers the same digest. The system prefix is byte-identical across
calls. The journal and the checkpoint are not modified. No version blocker was
found on `0.2.1-rc.3`.

### H. Product decision

```text
EF Active: deployment hold
deploymentEligible: false
```

R38-M0 found no product-level benefit and made no live model call. The
mechanism results are offline: a safety gate passed, relation authorization is
enforced, selection and recovery improve coverage on fixtures, and the native
delivery path works.

The next hypothesis to test is **S1/S2 vs the current Active**, on held-out
cases, under a bounded M1 manifest. A more complex memory architecture (graph,
embeddings, background memory agent) is **not** justified by these results.

## 2. Gate status

```text
R38-G0  repository / baseline integrity      passed
R38-G1  relation authorization safety        passed
R38-G2  commit / supersession integrity      passed
R38-G3  integrity auditor validity           passed
R38-G4  task-aware selection validity        passed
R38-G5  archive recovery validity            passed
R38-G6  recent-tail / native delivery        passed
R38-G7  product / experiment decision        passed
```

Strict exit 0 means the stage is complete, not that deployment is eligible.

## 3. What is not claimed

- No model was called in R38-M0.
- The selector, recovery and overlay are eval code, not production defaults.
- The cases are fixtures; certification is mechanism evidence.
- The relation rank does not distinguish a user decision from an assistant
  decision at the same authority. That limitation is documented, not hidden.
- Offline coverage is not a product benefit.

## 4. Evidence

```text
eval/r38/out/gate-status.json
eval/r38/out/mechanism-evaluation.json
eval/r38/out/baseline-manifest.json
docs/semantic-continuity/R38_HANDOFF.md
```
