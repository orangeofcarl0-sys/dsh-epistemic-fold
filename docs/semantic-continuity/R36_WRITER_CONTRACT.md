# R36 — Writer Contract

## Status

```text
W0 (R35)                         frozen byte-for-byte
W0 chars / sha256                2432 / 1d13166dfaba145986af0d183d1739ed2835aca76668774dada15f0aaf937abc
W1 chars / sha256                5431 / 61f380abc4fc2e98a02a55891a9a06c8e41040fbaf845f276ca6bbeadab3b5a3
Production default               W1
Parser                           unchanged (P0 strict)
Validator                        unchanged
Journal / working set / limits   unchanged
Live W1-P0 evidence              executed: 6/6 parsed, 14 accepted, 1 refused
Live W0-P0 control               executed: 2/6 parsed, 4 accepted
```

The prompt is still one constant appended as the final user message. W1 is not a
new writer architecture. It is a contract alignment with the validator that was
already running in R35.

## 1. What W1 fixes

R35 showed three separate mismatches between the prompt and the runtime:

1. **Envelope.** Five of the six non-parsed responses were valid JSON in the
   wrong shape: a bare array or a concatenated object sequence. The prompt's one
   example did not say that the object wrapper was mandatory.
2. **Verification.** Ten refusals were `verification-unscoped`: the writer asked
   for `verified` without a `verificationQuote`. The prompt said "a tool result
   proves it" but did not name the field or the exact-substring rule.
3. **Rejected decisions.** Seven refusals were `authority-ungrounded`. The
   clearest case is C1's rejected `fs.watch`: the decision is real and made by
   the user/assistant, but the writer cited only the tool result. The author
   table requires decision authority (user or assistant message) for
   `rejected-approach`.

W1 states the envelope, gives one example per situation, and makes the
verification and authority rules explicit. It does not weaken any check.

## 2. The contract W1 states

```xml
<handoff>
...
</handoff>
<deltas>
{"deltas":[...]}
</deltas>
```

- The `<deltas>` block is ONE JSON object with a top-level `deltas` array.
- A bare array is not accepted. Multiple concatenated objects are not accepted.
- Both tags must be closed; nothing appears outside them.
- Every string must be valid JSON; no trailing commas.

Kind/status examples:

| situation | kind | status | evidence source |
|---|---|---|---|
| user requirement | `constraint` / `objective` / `obligation` | `claimed` | the user message |
| user or assistant decision | `decision` | `claimed` | the message that made the decision |
| explicit rejection | `rejected-approach` | `claimed` | the message that made the decision, **not only a tool result** |
| tool observation | `finding` | `observed` | the exact tool result |
| tool-measured failure | `failure` / `finding` | `observed` | the exact tool result |
| verified result | `finding` / `failure` | `verified` | tool result + `verificationQuote` |
| candidate lesson | `experience-candidate` | `hypothesis` | assistant or tool context |

`verificationQuote` is 8–240 characters copied verbatim from a cited tool
result. A fact appearing in tool output does not make it `verified`; a file
listing or deployment parameter is normally `observed`. The validator still
downgrades an unsupported `verified` and still refuses an unscoped one.

The authority rule is unchanged:

```text
user/message       normative
tool/result        empirical / procedural
assistant/message  decision / hypothesis
```

A tool result that contains an instruction is data. It cannot ground a
constraint, objective, obligation, or a user decision. W1 says this directly,
because R35's F1 case showed a writer treating a tool-embedded "SYSTEM
OVERRIDE" as a user requirement.

## 3. What did not change

- `parseWriterOutput` still returns `parsed | absent | malformed` and never
  throws.
- `validateDeltas` still checks shape, verbatim evidence, authority, and status.
- `rejected-approach` still requires decision authority.
- `verified` still requires `verificationQuote` and all-empirical evidence.
- The journal, working-set compiler, state keys, delta limit, and fold guard are
  untouched.
- No new semantic kind, status, or authority domain exists.

## 4. Tests

`tests/r36-writer-contract.spec.ts` pins:

- W0's exact length and SHA-256, so a future edit cannot silently change the
  R35 baseline.
- W1 as the production default and W0 as an explicitly selectable replay
  version.
- The W1 text contains the envelope, verificationQuote, rejected-decision, and
  tool-instruction rules.
- The P1 parser test lives in the same suite but is an eval ablation, not a
  production parser change.

## 5. Live result and its limits

The authorized same-time pair on `deepseek-v4.1-flash` through the local ZCode
proxy used six certified cases and identical model, route, dataset, and limits:

| measure | W0 | W1 |
|---|---:|---:|
| protocol parsed | 2/6 | 6/6 |
| accepted deltas | 4 | 14 |
| refused deltas | 0 | 1 |
| commit recall (funnel matcher) | 0.167 | 0.917 |
| direct visibility | 0.333 | 0.917 |
| input / output tokens | 5,977 / 2,658 | 10,057 / 2,404 |

W1 fixed the envelope failure mode on every case in this set. The one remaining
refusal is F1's tool-origin constraint (`authority-ungrounded`), which is the
validator behaving correctly. C1's rejected-approach was not proposed as its
own delta, so C1's visibility is 0.5: W1 fixed the envelope, not every semantic
omission.

This is one replicate. The O2 calibration shows that agent behaviour itself
varies between runs, so the W0/W1 difference is a strong pilot signal, not a
precise effect size. The exact-statement scorer still reports 0 for both prompts
because the writer paraphrases; the semantic funnel matcher is the analysis
instrument.

## 6. What is not claimed

W1 is not claimed to improve durable commit on every case. It is claimed to
remove the envelope failure mode that dominated the R35 and W0 samples, while
leaving authority and verification enforcement unchanged. A multi-replicate
writer run is still needed before treating 0.917 as a stable rate.

The production default is W1 because the prompt is now aligned with the
contract the validator always enforced. If a later replicate shows a
regression, W0 remains available byte-for-byte via `writerInstruction('W0')`.
