# R37-C — Decision

## 1. The ten closure questions

### 1. How much of R37-B's writer “commit recall” was actually committed?

R37-B W1 reported 0.722. The corrected committed-fact recall is **0.514**.
W0 moves from 0.500 to **0.444**. The old number counted accepted facts from
fold-refused rows and accepted facts that did not remain the active anchor.

### 2. Why was strict critical recall zero?

It is a true exact-statement zero for parsed rows, not a missing field:

```text
field present 72/72
null 18 (protocol-not-parsed)
zero 54 (parsed)
non-zero 0
recomputed discrepancies 0
```

R37-B's `?? 0` aggregation hid the 18 nulls. The corrected report separates
them.

### 3. Was the Stage 1 preregistered admission condition met?

**Not verifiable.** The preregistration asked for turn-level rejection <= 10%;
the gate checked `unparsedTurnRate` (5.10%). The action-level rejection rate was
10.51%. The 1,000-character trace cap prevents an exact turn-level numerator.
The historical gate is recorded as `gate-not-verifiable`, not passed.

### 4. Which of the 11 Stage 2 invalid measurements were really invalid?

Only **2** are provider/transport-invalid. The other **9** are fold refusals in
the writer-only stage: observable pipeline outcomes, not censored measurements.
Fold refusals remain in the assigned-arm denominator.

### 5. What caused the 216 no-valid-action turns?

The denominator was also wrong: R37-B used 819 completed steps, but the traces
contain **903 model calls**. Against 903, the stored no-valid-action rate is
23.92%, not 26.37%. The reconstructed classes are:

```text
truncated-output     105
missing-parameter     79
invalid-envelope      51
normal-text-only      36
```

Not every no-valid-action turn is a parser bug. Some are normal text-only
turns; some are truncated output; some are genuinely rejected actions.

### 6. Can the DSML parser preserve supported source bytes?

Yes for the supported forms. The R37-C codec round-trips the fidelity corpus
through both the direct-attribute and parameter-body forms. Ambiguous input
(unclosed invoke, truncated parameter, duplicate/conflicting parameter,
missing content) is rejected with a diagnostic, not guessed.

### 7. What is the native N0/N1/N2 status?

All three pass:

```text
N0 native tool lifecycle   passed
N1 persistence and resume  passed
N2 EF integration          passed
```

The old `TOOL_NOT_STARTED` was a manual-host configuration error:
`AgentLoop` needs a volatile cell, not a plain number, for
`maxParallelToolCalls`. With `createVolatile(1)`, the loop records
`tool/call`, dispatches, records `tool/result`, and resumes without a synthetic
repair.

### 8. How strong is the statistics conclusion at case level?

The original exact McNemar result is preserved:

```text
1 rescue / 9 damage, p = 0.0215
```

Five of six cases are negative; H1 is flat. The case-level sign test is
p = 0.0625. Leave-one-case-out p ranges from 0.0078 to 0.0703. The direction is
consistent, but the result is one model, one route, one harness, six cases. It
is a harm signal, not a population estimate.

### 9. Was C2 eligible to run?

Yes. C0/C1 core gates passed, the route was available, and the frozen pilot
stayed within its caps:

```text
24/24 cells
187 HTTP attempts
226,808 input tokens
29,980 output tokens
504,096 ms
```

### 10. Does the evidence change the Active deployment hold?

No. The hold remains.

```text
Active benefit: not supported
Contract harm direction: present
Mechanism: mostly process/implementation, one H1 operationalization candidate
Representation effect: not confirmed
Guard: not beneficial in the C2 pilot
```

## 2. What R37-C fixed

- Evidence preservation: 381 reports, 2,919 files, archive hash, no secrets.
- Accepted vs committed vs rendered writer metrics.
- Measurement validity vs pipeline outcome.
- Case-level statistics, leave-one-case-out, sign test.
- Strict gate exit codes and machine/researcher decision separation.
- DSML byte fidelity, strict parsing, source boundary.
- Manifest authority over the runtime protocol.
- Native N0/N1/N2 lifecycle and the real `TOOL_NOT_STARTED` cause.
- H1-v2 visible/hidden contract without leaking `eu-west-2`.

## 3. What R37-C did not fix

- The R37-B Stage 1 admission cannot be verified retroactively.
- The 1,000-character trace cap remains in the historical archive.
- The C2 guard pilot does not explain the R37-B process harm; if anything, the
  guard is associated with worse contract success in this small sample.
- The second model and new held-out cases are preregistered, not executed.
- H-native is proven as a minimal smoke, not as the production evaluation
  runtime.

## 4. Product decision

```text
EF Active: deployment hold
Reason: no benefit signal; confirmatory contract harm direction;
        the process mechanism is not fixed by the guard;
        the measurement corrections do not reverse the direction.
```

The hold is not a claim that EF is harmful for every model, route, or task. It
is a claim that the current evidence does not support Active deployment and the
observed direction is negative.

## 5. Next executable step

Run the R37-D second-model preregistration in
`R37C_NEXT_PREREGISTRATION.md`: one new model, one route, P3s, six cases, six
replicates, with O2 and protocol preflight first. Do not bundle the guard into
the product arm; test it separately or not at all.
