# R36 — Decision

## Status

```text
Active vs Off                     Insufficient Evidence
Writer interface diagnosis        Positive Evidence
Benchmark validity                Positive Evidence (7/7 certified)
Parser envelope ablation          Positive Evidence (offline)
Writer prompt W1 effect           Not measured (live blocked)
Harness execution effect          Not measured (live blocked)
Real causal comparison            Blocked
```

R36 did not prove that EF Active is better than EF Off, and did not prove that
it is equivalent. It proved three narrower things:

1. The model's raw semantic understanding was not the bottleneck in R35: every
   gold fact appeared in every scoreable raw response.
2. The first loss was the writer's envelope, and a bounded parser recovery has
   a large, content-preserving offline effect on that failure mode.
3. The benchmark itself had a temporal scoring defect (D1) and an unexplained
   visible/hidden conflict (C1); both are now fixed and certified.

## Gate status

| gate | status | reason |
|---|---|---|
| G0 R35 evidence closed | passed | 17 attempts, 16 scoreable, 1 lost; six failures classified |
| G1 benchmark valid | passed | 7/7 cases certified; dataset digest unchanged; scorer v3 |
| G2 writer experiment | blocked | offline W0-P0/P1 complete; W1-P0 live not authorized |
| G3 agent identifiability | blocked | offline guard/diagnostics pass; H-native absent; live O2 not authorized |
| G4 real causal comparison | blocked | G2/G3 prerequisites and R36 authorization absent |
| G5 product decision | insufficient evidence | this document, limited to the evidence above |

`eval/r36/out/gate-status.json` is authoritative.

## The eight questions

### 1. Did the writer contract increase durable commits of correct facts?

**Not measured in R36.** W1 is implemented and frozen, but W1-P0 requires real
model calls. The offline P1 result is a parser result: on the same W0 outputs it
raises validator-accepted fact recall from 0.5625 to 0.875. It cannot tell us
whether the W1 prompt changes what the model writes.

### 2. Does parser tolerance have independent value?

**Yes, offline.** P1 structurally recovers 5 of 6 non-parsed responses, produces
20 additional validator-accepted deltas, and changes no fact, kind, status,
subject, or evidence. It does not recover the one genuine syntax error and it
does not claim durable commit. Its value is bounded to unambiguous envelope
errors, which is exactly what five of the six R35 failures were.

### 3. Did W1/P1 introduce wrong authority or status conflicts?

**No new conflict was observed offline.** W1 does not weaken the validator. P1
replays still produce the same 7 refusals (`4 verification-unscoped`,
`3 authority-ungrounded`), so the recovery does not launder authority. No
refused proposal appears in machine state; four appear as Rationale prose only.
A live W1 run is still required to see whether the new prompt reduces the seven
refusals without creating new overclaims.

### 4. Was the agent execution bottleneck improved?

**Offline guard behaviour is correct; live effect is not measured.** H-finish
rejects a premature finish, leaves the model in control, and allows the finish
only after a fresh passing test. It never runs the test itself. In the offline
test the unguided H0 row is a process violation; the guarded row reaches
contract success only after the model's own `run_tests`. That is not evidence
that unguided agents comply, and no O2 live calibration was run.

### 5. Did the oracle condition restore task completion?

**Not measured.** No R36 O2 run was authorized. H-native is not implemented, so
there is no native-runtime result either. R35's O2 arms were not a stable upper
bound, which is itself a reason not to treat R35's floor as a memory result.

### 6. Is Active better than Off?

**No valid R36 evidence.** R35's continuation pairs were 9 valid pairs in
r1/r3, all `neither`; r2 was excluded for the empty-checkpoint defect. That is a
behavioral floor, not equivalence. R36 did not add a B1/S run, so the answer
remains insufficient.

### 7. Were the extra tokens, latency, and retrieval worth it?

**Not measured.** R36 spent zero provider tokens. R35's 612 attempts and 466,125
input / 151,484 output tokens describe the earlier round, not a cost-benefit
result for W1 or the guard. No currency is reported because there is no trusted
price profile.

### 8. Should the next round change EF product mechanisms?

**No new memory architecture.** The evidence points at the interfaces already
in scope:

```text
writer envelope / contract      W1 implemented; needs a live pilot
parser tolerance                P1 proven offline; keep as an ablation until the prompt comparison is frozen
agent execution/process         H-finish implemented; needs O2 calibration
state delivery / recall         no evidence yet that changing it would help
MemoryOS / vector DB / new
compaction engine / prefetcher  not justified
```

## Recommended next step

When (and only when) explicit R36 model authorization is granted:

1. Run `w0-p0-live-control` and `w1-p0-live` on the six certified cases with
   the same model, route, dataset, and limits.
2. Run `h0-o2`, `h-step-o2`, `h-output-o2`, and `h-finish-o2` on the same
   cases. Stop and attribute if O2 still cannot complete a certified task.
3. Only then freeze the final conditions and run B1/S/O1/O2.

Do not pool R35 r1/r2/r3 with the new run. Do not treat guard-assisted success
as autonomous compliance. Do not call the 0/0 R35 pair result equivalence.

## Why this is a decision, not a delay

The round closed the evidence that could be closed without spending: the real
writer trace is reconstructed, the six protocol failures are separated, the
D1/C1 benchmark defects are fixed, W1 and P1 are implemented and frozen, and
the execution guard is tested. The remaining questions require model calls, and
the correct label for an unrun experiment is **Blocked**, not a fabricated
positive or negative.
