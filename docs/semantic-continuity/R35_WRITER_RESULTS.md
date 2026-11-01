# R35 — Writer Results

## Status

```text
real Semantic Writer calls:  0
real writer output bytes:    0
real writer tokens:          0
verdict:                     blocked / not executed
```

No real model was called. The writer-only pilot is ready and preflighted, but it
requires explicit spend authorization and a resolved route. Nothing in this
document is a real-model writer result.

## What was executed locally

### Writer-only self-test through the real EF fold

`--stage writer-only --cases A1 --arms S,O1`, with a scripted adapter and no
provider:

```text
rows:                 2
valid measurements:   2 / 2
writer calls:         2 (S real-path scripted; O1 oracle)
protocol:             parsed
commit status:        committed
state digest:         4c5ea81af3a6b2b066c1ac454de1a49ad0becd4004612c3d565b2631d3773788
raw writer chars:     380
raw writer digest:    6acb0da445427f40b0edfb60a6f05f9ae83188a0852a4975e3666d2ac5367f2e
```

The chain actually exercised:

```text
frozen session
  -> real EF active fold
  -> semantic writer call
  -> <handoff>/<deltas> parsing
  -> evidence validation
  -> commit planner
  -> journal packet + receipt
  -> state replay
  -> working set / checkpoint
  -> stop
```

No follow-up agent, tool loop, or checker ran in this stage. The scripted
adapter is explicitly labelled; it verifies plumbing, not model behaviour.

### Four-arm self-test through the real host

`--self-test` on all 17 development cases and B1/S/O1/O2:

```text
rows:                  68
valid measurements:    68 / 68
functional success:    68 / 68
contract success:      68 / 68
false verification:    0
visible test passes:   15 / 17 per arm
```

C1 and D1 are cases whose scripted plan does not make the visible suite green;
neither claims `verified`, so the contract metric does not call them false
verifications. D2, which does claim `verified`, now passes its visible suite and
its claim is fresh. This is an offline control, not a model result.

### Preflight writer bound

The real fold path asks for:

```text
writer/rationale maxTokens: 16,384
input reserve per request:  131,072
```

The R34 example manifest's 8,192 is therefore incompatible. The current example
uses 32,768 and preflights 12/12 feasible.

## What the writer-only live run must record

```text
writer call status and provider failure
protocol: parsed / absent / malformed / not-called
raw output (full artifact + digest; preview in the report)
handoff
proposed deltas
accepted deltas
refused deltas and refusal reasons
commit status
rendered checkpoint digest and text
replayed state digest
visible anchors
actual provider usage
```

The raw output artifact is capped at 512 KiB with an explicit truncation flag
and a digest of the full text. No header, token, or credential is written.

## What cannot be claimed

- No real protocol-validity rate.
- No real exact-claim recall, source-support rate, or false-normative rate.
- No real writer coverage.
- No real cost.
- No statement that the writer is or is not the bottleneck.

The first live pilot must save the raw evidence before anyone changes the writer
prompt.

## Next command (after authorization)

```bash
npm run eval:build
node eval/r33/live.mjs --preflight --manifest <authorized-manifest.json>
R33_LIVE=1 node eval/r33/live.mjs --run --stage writer-only \
  --cases A1,B2,C1,D1,F1,H1 --manifest <authorized-manifest.json>
```

The report is written to `$R33_RUN_ROOT/<runId>/report.json`. It is the
authoritative record; `eval/r33/out/live-report.json` is a convenience copy.
