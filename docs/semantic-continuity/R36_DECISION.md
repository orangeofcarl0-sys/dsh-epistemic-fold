# R36 — Decision

## Status

```text
Active vs Off                     Insufficient Evidence (exploratory mixed)
Writer interface diagnosis        Positive Evidence (live pilot)
Benchmark validity                Positive Evidence (7/7 certified)
Parser envelope ablation          Positive Evidence (offline)
Writer prompt W1 effect           Positive pilot (1 replicate, 6 cases)
Harness execution effect          Positive for H-protocol (5/6 contract)
Real causal comparison            Exploratory: 1 rescue / 3 damage / 4 both / 4 neither
```

R36 did not prove that EF Active is better than EF Off, and did not prove that
it is equivalent. It proved five narrower things:

1. The model's raw semantic understanding was not the bottleneck in R35: every
   gold fact appeared in every scoreable raw response.
2. The first loss was the writer's envelope. W1 removes it in the live
   same-time pilot (2/6 → 6/6 parsed; commit recall 0.167 → 0.917).
3. The benchmark itself had a temporal scoring defect (D1) and an unexplained
   visible/hidden conflict (C1); both are now fixed and certified.
4. The custom agent loop's real floor was the **tool protocol**, not the step
   budget: DSML invocations were ignored. H-protocol parses both JSON and DSML
   and reaches 5/6 contract success with correct facts visible; only D1 misses
   its `verification.json` artifact.
5. The exploratory B1/S result is mixed: 1 rescue, 3 damage, 4 both, 4 neither
   over 12 pairs. The damage is attributable to code/process or an A1
   task/gold ambiguity, not to missing memory. B2 damage is 2/2; C1 rescue is
   1/2. This is not an Active>Off claim.

## Gate status

| gate | status | reason |
|---|---|---|
| G0 R35 evidence closed | passed | 17 attempts, 16 scoreable, 1 lost; six failures classified |
| G1 benchmark valid | passed | 7/7 cases certified; dataset digest unchanged; scorer v3 |
| G2 writer experiment | passed | same-time W0-P0/W1-P0: 2/6 vs 6/6 parsed, commit 0.167 vs 0.917; P0/P1 separate |
| G3 agent identifiability | partial | H-protocol 5/6 contract; D1 verification artifact still fails; H-native absent |
| G4 real causal comparison | partial | 12 exploratory pairs, 2 replicates; mixed and confounded by A1 ambiguity/B2 code |
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

**Yes, by fixing the tool protocol.** The model emitted DSML invocations in two
syntaxes; H0 parsed neither, so read results were empty and 28 actions were
invalid. H-protocol parses JSON and both DSML forms. The best O2 condition then
reaches 5/6 task and **5/6 contract success**, with 0 process violations and 2
invalid actions. The finish guard was not the main lever; it fired only once in
the earlier conditions. The remaining D1 failure is a specific process gap: the
agent never writes `verification.json`.

### 5. Did the oracle condition restore task completion?

**Almost: 5/6 contract success under H-protocol.** Only D1 fails, for the missing
verification artifact. A1/C1/B2/F1/H1 succeed with correct facts visible. This
is a usable O2 floor and enough to identify code, protocol, and process failures.
H-native is still not implemented.

### 6. Is Active better than Off?

**No stable evidence; the exploratory result is mixed.** A B1/S comparison was
run under H-protocol: 12 valid pairs, 2 replicates.

```text
contract: 1 rescue, 3 damage, 4 both, 4 neither
task:     1 rescue, 2 damage, 5 both, 4 neither
```

B2 damage is 2/2, C1 rescue is 1/2, A1 is 1 damage / 1 neither. The A1 damage
is a task/gold ambiguity (the hidden checker requires `retries: 2` on the string
form, which the task text does not state); B2's S agent wrote a broken module or
skipped tests even though its checkpoint contained the decision. This is not a
clean memory-loss signal, and it is not equivalence. R35's 9 valid r1/r3 pairs
remain all `neither` and are not pooled.

### 7. Were the extra tokens, latency, and retrieval worth it?

**The writer pair and the protocol fix were the high-value work; the later
causal batch was expensive and noisy.** R36 spent 845 HTTP attempts, 777,005
input / 114,404 output tokens, 581,622 cache-read tokens, with 9 unknown-usage
attempts and 16 transport failures. The writer pair used 12 attempts; the
continuation calibration and causal runs used 833. No currency is reported.

### 8. Should the next round change EF product mechanisms?

**No new memory architecture.** The evidence points at the interfaces and the
execution environment:

```text
writer envelope / contract      W1 live pilot positive; replicate before treating 0.917 as stable
parser tolerance                P1 proven offline; keep as an ablation, not production
agent tool protocol             H-protocol fixed; 5/6 O2 contract
agent code/process              D1 verification artifact; B2 over-edit/test omission
A1 task/gold                    hidden retries-on-string requirement is not in the task text
state delivery / recall         no evidence yet that changing it would help
MemoryOS / vector DB / new
compaction engine / prefetcher  not justified
```

## Recommended next step

The authorization was used. The next step is not another memory feature:

1. Resolve A1's task/gold ambiguity: either state the `retries: 2` string-form
   requirement or relax the hidden checker. Do not count A1 damage as memory.
2. Fix the D1 verification artifact process.
3. Replicate the B2 damage and C1 rescue (currently 2/2 and 1/2).
4. Replicate W0/W1 and the causal pairs beyond two runs; implement H-native or
   keep it explicitly blocked.
5. Freeze a final harness and re-run B1/S/O1/O2 only after those confounds are
   removed.

Do not pool R35 r1/r2/r3 with the R36 runs. Do not treat guard-assisted success
as autonomous compliance. Do not call the 0/0 R35 pair result equivalence.
Do not call the exploratory 1/3/4/4 result an Active effect until A1/D1/B2 are
resolved.

## Why this is a decision, not a delay

The round closed the evidence that could be closed: the real writer trace is
reconstructed, the six protocol failures are separated, the D1/C1 benchmark
defects are fixed, W1 is live-tested against a same-time W0 control, the tool
protocol fix lifts O2 to 5/6 contract success, and a two-replicate B1/S
comparison exists. The remaining causal question is blocked by concrete
confounds—A1's unstated hidden requirement, D1's missing verification artifact,
and B2's code/process variance—not by a missing experiment or a missing
authorization.
