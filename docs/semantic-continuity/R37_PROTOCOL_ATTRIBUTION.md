# R37-A — Protocol Attribution

## 1. What was replayed

The offline corpus is every R36 trace that contains a follow-up model turn:

```text
58 runs
91 trace rows
732 model turns
```

Each saved turn is fed to six parser layers as the **same bytes**:

| layer | JSON | complete DSML | short attribute | multi-action | unescape | raw body |
|---|---|---|---|---|---|---|
| P0 | first only | no | no | no | no | no |
| P1 | first only | yes | no | no | no | no |
| P2 | first only | yes | yes | no | no | no |
| P3 | all | yes | yes | yes | no | no |
| P3e | all | yes | yes | yes | yes | no |
| P4 | all | yes | yes | yes | yes | yes |

P3 is the R36 parser's behavior. P3e is a proposed correction. P4 is an
experimental layer and is **not** production behavior.

## 2. Layer results

| layer | valid actions | invalid actions | turns with no action | multi-action turns |
|---|---:|---:|---:|---:|
| P0 | 302 | 0 | 430 | 0 |
| P1 | 472 | 145 | 115 | 0 |
| P2 | 555 | 62 | 115 | 0 |
| P3 | 852 | 74 | 115 | 155 |
| P3e | 852 | 74 | 115 | 155 |
| P4 | 856 | 70 | 115 | 155 |

Marginal recovery:

```text
P0 → P1   +170 complete DSML actions
P1 → P2    +83 short-attribute actions
P2 → P3   +297 additional actions in multiple-action turns
P3 → P3e     0 additional actions; attribute content changes
P3e → P4    +4 raw-body write actions (experimental)
```

P3e does not add actions because the corrupted content was already a string.
Its effect is on the **value**, not the count. The deterministic B2 test shows
why that matters.

The invalid-action count is not the R36 `invalidActions` metric. R36 counted a
turn as invalid only when its parser found zero actions. R37 also validates the
parsed action: unknown tool, missing parameter, wrong type, path escape. P3's 74
invalid actions are mostly `missing-parameter` (72) and `path-escape` (2).

## 3. Deterministic B2 dispatch recovery

The B2 r1 S final workspace is the actual dispatch result. It contains:

```text
throw new Error(\`queue is full (maxSize \${maxSize})\`)
```

The backslash-backtick and backslash-dollar-brace are DSML attribute escapes
that were copied into the file instead of being decoded.

| condition | `node --check` | hidden checker |
|---|---|---|
| P3 (stored bytes) | fail | fail (`module-load`, `functionality.fifo`, `decision.in-memory`) |
| P3e (decode `\`` and `\${`) | pass | pass (`functionality.fifo`, `decision.in-memory`) |

This is **deterministic dispatch recovery** in an isolated copy. It does not
prove that the next live model turn would choose the same action; that is
R37-B's question. It does prove that the R36 B2 r1 "implementation failure" was
caused by the harness's parameter decoding, not by the in-memory decision.

## 4. Trace truncation is an evidence limit

The R36 trace stores `text.slice(0, 1000)`. A turn at 1000 characters may be cut
before its closing `</DSML invoke>`. The offline parser then sees an unclosed
invoke. That is not evidence that the live model emitted an invalid turn.

The report separates:

```text
truncatedSteps                 turns at the 1000-character cap
unclosedInvokeSteps            saved prefixes without a closing invoke
partialWritePrefixSteps        a write prefix without content before the cap
```

These are `unresolvedHypotheses`, not failure candidates. The R36 report's live
`validActions`/`invalidActions` are retained for comparison; 42 of 91 rows match
the offline P3 count exactly. The mismatch is expected when a turn was parsed
live from bytes the trace no longer stores.

## 5. Safety behavior

The R37 parser is provenance-aware:

- `analyzeTurn(text, layer, 'model')` may parse actions.
- `analyzeTurn(text, layer, 'tool-result' | 'file-content' | 'user-message')`
  returns zero actions and an `untrusted-source` diagnostic.

This is tested. A tool result or file body containing an exact DSML invocation
is data, not permission.

Rejected rather than guessed:

| case | behavior |
|---|---|
| unclosed invoke | no action; `truncated-invoke` diagnostic |
| bare short attribute with no invoke | no action |
| unknown tool | invalid `unknown-tool` |
| missing required parameter | invalid `missing-parameter` |
| wrong parameter type | invalid `parameter-type` |
| path escape | invalid `path-escape` |
| duplicate request | kept, marked `duplicate`, diagnostic recorded |
| multiple actions | parsed by P3+, diagnostic recorded |

P4 is the one deliberate exception: it treats the residual body of a write
invoke as content. It is labelled experimental, adds four actions, and is not in
the confirmatory harness.

## 6. What this proves and what it does not

Proved offline:

- complete DSML and short-attribute forms account for 253 recovered actions
  beyond JSON-only parsing;
- multiple-action turns account for another 297;
- the B2 r1 S file is valid after attribute unescaping and the hidden checker
  then passes;
- untrusted text is not dispatchable;
- the current parser has a deterministic escape-decoding defect.

Not proved:

- that P3e raises live task success;
- that the four P4 raw-body actions are safe to accept;
- that every unparsed turn was a model error rather than trace truncation;
- that a protocol improvement is evidence for EF.

The last point is the R37 boundary: a harness repair changes the measurement
floor, not the product effect.
