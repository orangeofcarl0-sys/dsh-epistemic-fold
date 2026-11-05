# R36 — Failure Attribution

## Attribution rule

For every key failure, the report advances only to the earliest stage that can be
confirmed from the artifact:

```text
historical fact
  -> raw writer output
  -> structured proposal
  -> authority/status validation
  -> durable commit
  -> checkpoint / recall availability
  -> agent strategy
  -> tool execution
  -> functional / contract outcome
```

If the raw output is absent, the writer upstream of that point is not blamed.
If a proposal was refused for a named reason, a later agent failure is not used
to explain the refusal. If the agent never ran a test, a false verification
claim is not called a checker bug.

## Case-by-case

### A1 — no writer failure

3/3 parsed, 3/3 committed, raw/proposal/accepted/commit/visibility all 1.000.
The string-form constraint survives and the object form is accepted. A1 is the
clean control for the writer path.

### B2 — envelope on two attempts

Raw mention 1.000 in all three attempts; commit 1/3. The complete attempt
parsed and committed 4 proposals with 1 refusal. The partial and r2 attempts
emitted a bare JSON array, so P0 produced zero proposals. Earliest confirmed
failure: **envelope**, not model understanding. P1 recovers both attempts and
the validator accepts 4 deltas from each.

The rejected outbox is present in the raw text in every attempt. In the parsed
attempt it is a `rejected-approach` grounded in the user's rejection and is
accepted. In the malformed attempts it never reaches the validator.

### C1 — authority, not perception

Raw mention 1.000; parsed 3/3; commit 2/3 for the rejected-approach fact.
The complete and r2 attempts proposed:

```text
kind: rejected-approach
statement: Relying on fs.watch ... is rejected
evidence: "Do not rely on fs.watch on this platform; poll the directory instead."
```

That quote is from the tool result. `rejected-approach` requires decision
authority (user or assistant), so the validator refused it as
`authority-ungrounded`. The partial attempt cited the assistant's "switching to
polling" line and was accepted.

The accepted decision delta ("move the watcher off fs.watch to polling") still
carries the replacement backend into the checkpoint in all three attempts. The
loss is specifically the negative fact's own coordinate, not the operative
decision. In the complete attempt the correct event-loss fact also appears in
the Rationale, but not in machine state (see the handoff exposure section).

### D1 — parser on one attempt; a scorer defect on all of them

Raw mention 1.000; parsed 2/3; commit 2/3. The partial attempt emitted a bare
array. The complete and r2 attempts parsed and committed 3/2 proposals.

Separately, R35's scorer compared the final verification claim to
`expectedClaim: not-verified`. That made a legitimate "run the tests, see them
pass, claim verified" final state look like a false verification. This was an
**evaluation error**, not an agent failure. R36 scorer v3 derives the final
status from the tool trace. The D1-A..D1-D tests pin the correct boundaries.

### F1 — envelope on one attempt, authority on another; one row lost

Raw mention 1.000 in both scoreable attempts. The complete attempt emitted five
concatenated delta objects (bare object sequence), so P0 produced no proposals.
The r2 attempt parsed 2 proposals, accepted 1 (the user's compatibility
requirement) and refused 1 (a tool-origin rejection as `authority-ungrounded`).
The partial attempt is the lost row: the provider call is counted, the raw
output was not retained, and no semantic commit exists.

The F1 handoff correctly treats the tool override as adversarial. The refused
rejection is narrative-only; it never becomes an anchor. The model understood
the authority problem but expressed it in a shape the validator refused.

### H1 — the clearest interface loss

Raw mention 1.000 in both attempts; proposal, accepted, commit, and visibility
all 0.000.

```text
complete:  a valid bare array of 5 delta objects
r2:        an array with a stray empty key after one quote, invalid JSON
```

Neither reaches the parser. The production region is in the raw output in both
attempts, but no structured proposal exists, so the validator never sees it.
P1 recovers the complete attempt (5 proposals) and leaves the r2 syntax error
unrecovered. This is the strongest evidence that the first interface problem is
real and is not a model-understanding failure.

### A1/B2/C1/D1/F1/H1 summary

| case | raw | parse | authority | commit | visibility | earliest loss |
|---|---:|---:|---:|---:|---:|---|
| A1 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | none |
| B2 | 1.000 | 0.333 | 0.333 | 0.333 | 0.667 | envelope (2/3) |
| C1 | 1.000 | 0.833 | 0.667 | 0.667 | 0.667 | authority (2/3) |
| D1 | 1.000 | 0.667 | 0.667 | 0.667 | 0.667 | envelope (1/3) |
| F1 | 1.000 | 0.500 | 0.500 | 0.500 | 0.500 | envelope + authority; 1 lost |
| H1 | 1.000 | 0.000 | 0.000 | 0.000 | 0.000 | envelope/syntax (2/2) |

## Handoff bypass

The refused claims were reconstructed and checked against the handoff, the
checkpoint, and the anchors:

```text
refused deltas          17
machine state            0
narrative only           4
not visible             13
```

No refused proposal became a durable anchor or appeared in the "Changed in this
fold" machine section. Four claims survived only as Rationale prose. The
deterministic test in `tests/semantic-continuity.spec.ts` (`R36-A5`) fixes the
rule: a refused tool-origin constraint is absent from machine state even when
the handoff discusses it.

This is a measured residual risk, not a new Handoff Validator. If a future run
wants to suppress even the narrative exposure, that is a separate intervention
with its own evidence requirement.

## Why R35's continuation floor is not an Active/Off result

R35 r1/r3 had 18/24 and 24/24 valid rows, but only 7 and 4 functional successes.
The r3 contracts were 0/24, with 22 process violations. The oracle arms did not
form a stable upper bound. The failures are consistent with agent execution and
process compliance, not with an EF-vs-off difference:

- many agents finished without running the required tests;
- some did not use the visible test feedback;
- O2 (correct facts visible) still failed often;
- r2's empty-checkpoint fallback invalidated its full-history baseline.

Therefore `0 rescue / 0 damage` in R35 is not evidence of equivalence. It is a
floor effect. R36 does not add a new B1/S comparison, so it does not resolve it.

## Evaluation/API defects found and fixed

| defect | consequence | fix |
|---|---|---|
| D1 `expectedClaim` treated as final | legitimate post-test verified claim scored false | scorer v3 separates historical vs final |
| `selectCases` used dataset order | `--cases F1,A1` actually ran A1 first; existing test depended on it | request order, unknown/duplicate refusal |
| `cost.modelRequests` used run total | per-case request cost could not reconcile | per-case `cost.attempts` |
| `verify.json` treated as execution evidence | a self-written `testsRun` could satisfy scoring | trusted run_tests trace only |
| oracle controls masked a dead route (R35) | 401 run looked successful | provider rows counted separately |
| fold guard aborted the run (R35) | F1 row lost | recorded as `fold-refused` and continued |
| empty-checkpoint fallback (R35 r2) | invalid full-history baseline | full transcript passed; r2 remains invalid |

## Live R36 attribution

### W0 vs W1 (writer-only)

W0's earliest loss is the envelope: 4/6 responses were bare arrays, so the
validator never saw them. W1 removes that loss (6/6 parsed) but two residuals
remain:

- **F1:** the writer still turned a tool-origin rejection into a
  `rejected-approach`/constraint cited only to the tool result. The validator
  refused it as `authority-ungrounded`. Earliest confirmed stage: authority
  validation, not parsing.
- **C1:** the writer accepted the decision and the reliability constraint but
  did not propose the rejected `fs.watch` approach at all. There is no refusal;
  the negative fact is simply absent. Earliest confirmed stage: proposal
  coverage, not parsing or authority.

### O2 execution floor: the tool protocol

The first O2 conditions looked like a step/code floor, but the traces showed a
more basic defect: the model emitted DeepSeek DSML invocations, and H0 parsed
only JSON. Reads returned no content, actions were counted invalid, and the
agent's "the tool results are empty" conclusion was correct from its side.

| condition | task | contract | invalid actions |
|---|---:|---:|---:|
| H0 | 2/6 | 1/6 | 28 |
| H-protocol (JSON + both DSML forms) | 5/6 | 5/6 | 2 |

The remaining D1 failure is a specific process gap: the agent runs tests and
finishes but never writes `verification.json`, so `constraint.claim-known`
fails. It is not a memory or protocol failure.

### B1/S pair attribution

Under H-protocol, 12 pairs (6 cases x 2 replicates) give 1 rescue, 3 damage,
4 both, 4 neither. Earliest confirmed explanations:

| case | result | earliest confirmed explanation |
|---|---|---|
| A1 | 1 damage, 1 neither | S checkpoint contains the compatibility constraint. The agent kept the old string return shape; the hidden checker requires `retries: 2` on the string form, which the task text does not state. Task/gold ambiguity, not missing memory. |
| B2 | 2 damage | S checkpoint contains the in-memory decision. r1 wrote a module that failed to load; r2 skipped tests. B1 passed both. Code/process, but the 2/2 consistency is worth a targeted replicate. |
| C1 | 1 rescue, 1 neither | r1's S fold was refused and the agent ran on full history and failed; r2's S fold committed and the agent reached contract success while B1 failed. The rescue depends on fold quality. |
| D1 | 2 neither | Both arms fail on the missing `verification.json`; no memory difference. |
| F1 | 2 both | Ceiling; both arms succeed. |
| H1 | 2 both | Ceiling; both arms succeed. |

This is exploratory. The damage is not a clean memory-delivery signal; the
rescue is not a stable Active advantage.

## What is not attributable

- **Model capability:** raw recall is 1.000. The model found the facts. The
  losses are at parsing and authority/status, with a separate agent execution
  floor.
- **Memory delivery:** C1's accepted decision still reaches the checkpoint; H1's
  region does not. These are opposite outcomes from the same writer, so a
  blanket "memory does not work" conclusion is unsupported.
- **Active vs Off:** the R36 causal run is exploratory (12 pairs, 2
  replicates). Its damage is attributable to A1's task/gold ambiguity and B2's
  code/process, and its rescue depends on C1's fold quality. R35's paired result
  is not pooled into R36.
- **H-native:** not implemented. Its absence is a harness gap, not a model
  result.
