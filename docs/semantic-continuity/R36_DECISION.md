# R36 — Decision

## Status

```text
Active vs Off                     Insufficient Evidence
Writer interface diagnosis        Positive Evidence (live pilot)
Benchmark validity                Positive Evidence (7/7 certified)
Parser envelope ablation          Positive Evidence (offline)
Writer prompt W1 effect           Positive pilot (1 replicate, 6 cases)
Harness execution effect          Partial; no stable upper bound
Real causal comparison            Blocked by the O2 execution floor
```

R36 did not prove that EF Active is better than EF Off, and did not prove that
it is equivalent. It proved four narrower things:

1. The model's raw semantic understanding was not the bottleneck in R35: every
   gold fact appeared in every scoreable raw response.
2. The first loss was the writer's envelope. W1 removes it in the live
   same-time pilot (2/6 → 6/6 parsed; commit recall 0.167 → 0.917).
3. The benchmark itself had a temporal scoring defect (D1) and an unexplained
   visible/hidden conflict (C1); both are now fixed and certified.
4. Even with the correct facts directly visible, the custom agent loop reaches
   only 3/6 contract success at best. A1/C1 fail on code, B2 never runs the
   required test, and A1 varies between runs. That floor, not the memory
   mechanism, blocks the causal comparison.

## Gate status

| gate | status | reason |
|---|---|---|
| G0 R35 evidence closed | passed | 17 attempts, 16 scoreable, 1 lost; six failures classified |
| G1 benchmark valid | passed | 7/7 cases certified; dataset digest unchanged; scorer v3 |
| G2 writer experiment | passed | same-time W0-P0/W1-P0: 2/6 vs 6/6 parsed, commit 0.167 vs 0.917; P0/P1 separate |
| G3 agent identifiability | partial | O2 conditions separate code, process, step, and guard failure; best 3/6 contract success; H-native absent |
| G4 real causal comparison | blocked | not authorization: O2 does not form a stable upper bound, so B1/S was intentionally not run |
| G5 product decision | insufficient evidence | this document; Active vs Off is not claimed |

`eval/r36/out/gate-status.json` is authoritative.

## The eight questions

### 1. Did the writer contract increase durable commits of correct facts?

**Yes in the live pilot, with one replicate.** Same model, route, dataset,
limits, and six cases:

```text
W0-P0: 2/6 parsed, 4 accepted, 0 refused, commit recall 0.167, visibility 0.333
W1-P0: 6/6 parsed, 14 accepted, 1 refused, commit recall 0.917, visibility 0.917
```

The gain is concentrated in the envelope: W0 emitted four bare arrays and one
fold refusal; W1 emitted none. It is not a uniform semantic win: C1's
rejected-approach is still absent (visibility 0.5), and F1's tool-origin
constraint is still refused for `authority-ungrounded`. The pilot is strong
evidence for the contract fix, not a precise effect size.

### 2. Does parser tolerance have independent value?

**Yes, offline.** P1 structurally recovers 5 of 6 non-parsed responses, produces
20 additional validator-accepted deltas, and changes no fact, kind, status,
subject, or evidence. It does not recover the one genuine syntax error and it
does not claim durable commit. Its value is bounded to unambiguous envelope
errors, which is exactly what five of the six R35 failures were.

### 3. Did W1/P1 introduce wrong authority or status conflicts?

**No new conflict was observed.** W1 does not weaken the validator. The live W1
run produced 14 accepted deltas and exactly one refusal: F1's tool-origin
constraint, refused as `authority-ungrounded`. That is the correct authority
boundary. No refused proposal appears in machine state in the live writer run.
P1 replays still produce the same 7 refusals, so the recovery does not launder
authority. C1's missing rejected-approach is an omission, not an overclaim.

### 4. Was the agent execution bottleneck improved?

**Partially, and not enough for a causal run.** The finish guard works as a
mechanism: it rejects a premature finish and never runs the test itself. In the
live O2 calibration, however, it fired only once (D1) because the failing agents
usually never requested finish. The best condition was the exploratory 16-step +
guard combination: 4/6 task success, 3/6 contract success. A1 and C1 fail on
code; B2 never runs the required test. A1 passed under H-step and failed under
the combined condition, so one replicate per cell is visibly noisy.

### 5. Did the oracle condition restore task completion?

**Partially: 3/6 contract success at best.** O2 is not a stable upper bound.
A1/C1 are code failures, B2 is a process/test-omission failure, D1 needs the
combined condition, and F1/H1 succeed in most conditions. H-native is still not
implemented. This is enough to identify failure categories, not enough to
attribute a B1/S difference to memory delivery.

### 6. Is Active better than Off?

**No valid R36 evidence.** R36 was authorized but deliberately did not run
B1/S: the best O2 condition reaches only 3/6 contract success, with A1/C1 code
failures and B2 test omission. A B1/S comparison would be dominated by that
execution floor, exactly the double-failure accumulation the brief forbids.
R35's 9 valid r1/r3 pairs remain all `neither` and are not equivalence.

### 7. Were the extra tokens, latency, and retrieval worth it?

**The writer pilot was cheap and informative; the O2 calibration was expensive
and diagnostic.** R36 spent 419 HTTP attempts, 328,150 input / 46,333 output
tokens, 233,466 cache-read tokens, with 9 unknown-usage attempts and 16
transport failures. The writer pair used only 12 attempts and produced the
clearest result of the round. The O2 calibration consumed the rest and showed
that the agent, not the memory policy, is the current limiter. No currency is
reported.

### 8. Should the next round change EF product mechanisms?

**No new memory architecture.** The evidence points at the interfaces and the
execution environment:

```text
writer envelope / contract      W1 live pilot positive; replicate before treating 0.917 as stable
parser tolerance                P1 proven offline; keep as an ablation, not production
agent code/process              A1/C1 code failures and B2 test omission are now the limiter
agent harness                   H-combined 3/6 contract; needs replicates and a working H-native
state delivery / recall         no evidence yet that changing it would help
MemoryOS / vector DB / new
compaction engine / prefetcher  not justified
```

## Recommended next step

The authorization was used, and the next step is **not** B1/S yet:

1. Replicate W0/W1 at least three times to turn the 0.917 pilot into a stable
   estimate.
2. Calibrate A1/C1 code execution and B2 test process. These are the cases that
   keep O2 below a usable floor.
3. Replicate the harness conditions; A1 already moved between H-step and
   H-combined, so single runs are not a basis for a frozen harness.
4. Implement H-native or keep it explicitly blocked.
5. Only then freeze a B1/S harness and run the paired comparison.

Do not pool R35 r1/r2/r3 with the R36 runs. Do not treat guard-assisted success
as autonomous compliance. Do not call the 0/0 R35 pair result equivalence.

## Why this is a decision, not a delay

The round closed the evidence that could be closed: the real writer trace is
reconstructed, the six protocol failures are separated, the D1/C1 benchmark
defects are fixed, W1 is live-tested against a same-time W0 control, and the O2
calibration identifies the execution floor. The remaining causal question
requires a better agent/harness floor, not more B1/S rows on the current one.
