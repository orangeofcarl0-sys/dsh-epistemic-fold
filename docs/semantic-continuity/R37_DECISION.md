# R37-A — Decision

## 1. Can R36's authoritative result be independently reconstructed?

Yes. The 12 pairs reproduce exactly from the report rows and trace bytes:

```text
contract  1 rescue / 3 damage / 4 both / 4 neither
task      1 rescue / 2 damage / 5 both / 4 neither
```

All 36 arm rows pass the reconstruction integrity checks. The discrepancy
report has zero score discrepancies. Its 12 notes are `arm-not-run`: the r2
replicates did not execute O1/O2.

The reconstruction adds information the aggregate did not carry:

- one S run (C1 r1) was a full-history fallback, not a semantic checkpoint;
- D1 r1 wrote `verification.json` with invalid claim strings, while D1 r2 had a
  missing or empty artifact;
- B2 r1's S failure is a DSML escape-decoding defect, and the hidden checker
  passes once the saved file is unescaped.

## 2. Which protocol problems now have deterministic evidence?

Confirmed:

- Complete DSML and short-attribute DSML are real forms in the saved traces.
  Across 732 turns, P1 recovers 170 actions beyond JSON, P2 another 83, and P3
  another 297 in multi-action turns.
- The B2 r1 S final file fails `node --check` and the hidden checker; decoding
  `\`` and `\${` makes both pass. This is reproducible on the saved bytes.
- The parser does not dispatch text from a tool result or file as an action when
  the source is marked untrusted.
- Missing, unclosed, unknown-tool, wrong-type, and path-escape actions can be
  rejected with diagnostics instead of guessed.

Not deterministic from the archive:

- whether every turn at the 1000-character trace cap was invalid live;
- whether P3e improves a live agent's next action;
- whether P4 raw-body content is safe to adopt.

P4 remains experimental and is not in the confirmatory harness.

## 3. Are A1 and D1 validity problems fixed?

At the benchmark level, yes, in versioned cases:

- A1-v2 states the string-form `retries: 2` rule in the task and asserts it in
  the visible test. Its reference passes visible and hidden; a string-form
  counterfactual fails the hidden check.
- D1-v2 states the exact `verification.json` contract and the
  `verified`/`not-verified` vocabulary. Its reference passes; a false `verified`
  artifact fails `constraint.claim-accuracy`.

The old A1/D1 bytes and R36 scores are unchanged, and the v2 cases are not
pooled with them. No live model has seen the v2 cases; this is a certification
result, not a new behavioral score.

## 4. Where did B2's two damage runs first diverge?

**r1 S:** the checkpoint contains the in-memory decision and the model wrote
code that kept it. The saved write prefix at step 5 is truncated; the confirmed
divergence is step 7's DSML attribute content, which retained literal escapes.
The sufficient cause is `tool-parameter-corruption`. The checker passes after
decoding. This is a harness failure, not a decision-consistency failure.

**r2 S:** the agent read seven files, wrote none, and ran no test in eight
steps. The final workspace is byte-identical to the initial workspace. The
sufficient cause is `implementation-failure`; the observable decision state is
`no-observed-action`. This is a process stop, not a lost fact.

## 5. Did C1's fold/fallback create a treatment/delivery mismatch?

Yes, in r1. The assigned arm is S, but the fold packet status is `aborted` and
the harness continued on the full transcript. The fact was visible, but this is
not a delivered semantic checkpoint. It must be reported as
`full-history-fallback` and excluded from semantic-checkpoint mechanism
analysis. The assigned-arm product analysis still includes it.

In r2 the fold committed, the rejected-approach anchor is in the checkpoint,
and the agent wrote a polling watcher that passed. That is a candidate memory
signal at n=1, not a product effect.

## 6. Which failures have evidence for a representation relationship?

None are confirmed.

- B2 r1: the fact was rendered, the action was consistent with it, and the
  failure was a parameter-decoding defect. Representation is not the cause.
- B2 r2: no action was taken; there is no representation contrast.
- C1 r1: fallback plus implementation failure; the fact was visible.
- C1 r2: a candidate rescue, n=1, and the B1 arm also had a checkpoint carrying
  the canary rationale. It cannot isolate the semantic representation.
- D1: verification artifact/process failures, not a semantic fact delivery.
- A1: task/gold ambiguity.
- F1/H1: ceiling.

The controlled F-P/F-S/F-N and F-H/F-P/F-S fixtures are prepared, but they are
not run. They are the R37-B instrument, not evidence.

## 7. What remains only a hypothesis?

- Why B2 r2 stopped without writing.
- Whether P3e raises live task success after the first corrupted write.
- Whether the C1 r2 rescue replicates.
- Whether plain vs structured representation changes action choice.
- Whether a real DSH native runtime changes the harness floor.
- Whether the R36 trace cap hides additional protocol failures.

## 8. Is R37-B ready to start?

Offline readiness: yes. The evidence reconstruction, protocol ablation,
benchmark certification, forensics, and preregistration are complete.

Live readiness: **not yet authorized**. R37-B requires a new explicit spend
authorization, a frozen manifest, a resolved route, and positive
request/token/wall-clock limits. H-native remains blocked until the real DSH
Agent/Tool Runtime is implemented. G5 is `ready-not-authorized`, not passed.

## 9. Is there a reason to change the EF Active vs Off product decision?

No.

```text
Product decision: insufficient evidence
```

R37-A found:

- a real harness defect (DSML attribute decoding);
- two benchmark defects (A1 hidden string rule, D1 claim vocabulary);
- one delivery-policy mismatch (C1 fallback);
- no stable Active advantage and no stable Active harm after removing those
  confounds.

A harness repair is not EF evidence. A benchmark repair is not EF evidence. A
single C1 pair is not a product effect. The product decision stays
`insufficient evidence` until R37-B's preregistered analysis produces a
defensible result.
