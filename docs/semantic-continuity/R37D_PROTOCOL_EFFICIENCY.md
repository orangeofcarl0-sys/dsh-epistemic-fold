# R37-D — Protocol Efficiency

## 1. Denominators

The C2 report mixes counters that are easy to conflate:

```text
modelCalls          one provider response, including a response with no action
completedSteps      one loop iteration; a finish accepted at step N means
                    N + 1 model calls
toolCalls           non-finish actions actually dispatched
validActions        parsed actions that passed validation
rejectedActions     parsed actions the validator rejected
noValidActionCalls  responses that produced no executable action
```

`noValidActionCalls` is the correct numerator for a no-valid-action rate, and
`modelCalls` is the correct denominator. A rejected action inside a turn that
also contained a valid action is not a no-valid-action turn.

## 2. C2 totals

```text
cells                  24
model calls            163
completed steps        153
tool calls             144
valid actions          158
rejected actions        16
no-valid-action calls   46
no-valid-action rate    28.22%
tests executed          28
finish requests         14
step-limit cells        14
```

No-valid-action classes:

| class | turns |
|---|---:|
| `invalid-envelope` | 30 |
| `missing-parameter` | 13 |
| `truncated-output` | 6 |
| `natural-language-only` | 2 |

No turn was classified `unknown-tool`, `duplicate-action`, `unsupported-tool`,
or `tool-dispatch-failure`.

## 3. B2 and D1 are different protocol problems

| quantity | B2 | D1-v2 |
|---|---:|---:|
| model calls | 86 | 77 |
| no-valid-action calls | 35 | 11 |
| no-valid-action rate | 40.70% | 14.29% |
| rejected parsed actions | 16 | 0 |
| tests executed | 13 | 15 |
| finish requests | 3 | 11 |
| step-limit cells | 9 | 5 |

B2's no-valid classes:

```text
invalid-envelope    20
missing-parameter   13
truncated-output     6
natural-language     1
```

D1's no-valid classes:

```text
invalid-envelope    10
natural-language     1
```

B2 is dominated by malformed or incomplete DSML. D1's invalid turns are also
malformed envelopes, but D1 has no parsed-but-rejected actions: its malformed
writes never become action objects, so `rejectedActions` alone understates the
protocol failure. `noValidActionCalls` is the honest count.

## 4. Attribution

### Parser

The P3s parser rejects the stored text for a reason visible in the text:

```text
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ path"src/scheduler.mjs</｜｜DSML｜｜>          malformed short form
</｜｜DSML｜｜ invoke>
```

```text
<｜｜DSML｜｜ invoke name="write_file">
<｜｜DSML｜｜ path="verification.json">
<｜｜DSML｜｜ content="{...                      unclosed parameter
```

The parser does not invent missing parameters and does not dispatch a partial
write. No stored case shows a valid request being rejected by the parser.

### Model output

The immediate cause is the model's output format: unclosed `invoke` and
`parameter` tags, a short `path"..."` form that is not the declared attribute
form, and repeated empty invokes. In B2 the same model alternates between DSML
and JSON within one run.

### Output budget

Six turns ended with `finishReason: max-tokens`. Those are the only turns
classified `truncated-output`. The follow-up output budget is 1,024 tokens;
DSML with repeated tags and a long `content` parameter can exhaust it.

A model that emits an unclosed tag and stops with `finishReason: stop` is not
`truncated-output`; it is `invalid-envelope`. The distinction matters: the
first is a budget problem, the second is a generation problem.

### Tool capability

When an action is valid, the tool executes. Every valid `read_file`,
`write_file`, `run_tests`, `list_dir`, and `recall` call produced a result.
There is no `tool-dispatch-failure` in the sample. Tool capability is not the
bottleneck.

### Planning

Planning contributes independently:

```text
B2 cells with no test                 3/12
B2 cells whose first test is step >=4 5/12
B2 cells whose first test is step <=1 4/12
B2 cells with a repeated read         2/12
B2 cells with legal code but no test  0/12
```

The three no-test cells spent all eight steps on reads and malformed calls. The
cells that tested early were the ones that completed. This is descriptive, not
a causal estimate, but it is consistent with a step-budget problem rather than
a tool-capability problem.

## 5. Multi-action semantics

The custom loop executes every non-finish action in the model's order, then
evaluates one finish request:

```text
model order     read_file, write_file, finish
runtime order   read_file, write_file, then finish
```

If the model emits `finish` first, the write still executes before the finish is
evaluated. The finish is a control action, not an ordered tool call. This is now
an explicit helper (`eval/r33/src/action-order.mjs`) with deterministic tests;
the loop's behaviour is unchanged.

In the C2 sample:

```text
turns with multiple actions        21
turns with finish before a write    0
```

No C2 cell exercised the reordering case. The contract is tested, not inferred
from a sample that never used it.

## 6. What the numbers do not say

- A no-valid-action turn is not automatically a parser bug. It is a consumed
  model call; the class says why no action was executable.
- The 1,000-character trace cap means a turn at the cap is a stored prefix.
  Fourteen of 163 turns are in that state. The counters remain authoritative.
- The B2/D1 difference is confounded with task content, context arm, and the
  model's formatting behaviour. It is not an EF effect.
- `rejectedActions` counts parsed actions only. Use it together with
  `noValidActionCalls`, never alone.

## 7. Artifacts

```text
eval/r37d/src/action-accounting.mjs
eval/r37d/analyze-protocol.mjs
eval/r37d/out/action-accounting.json
eval/r37d/out/protocol-efficiency.json
tests/r37d-protocol.spec.ts
```
