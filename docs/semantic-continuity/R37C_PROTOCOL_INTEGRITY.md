# R37-C — Protocol Integrity

## 1. Byte fidelity

R37's P3e parser used a value regex, `trim()`, and repeated string replacement
for escapes. That cannot preserve a JavaScript template literal, a JSON
document with escaped quotes, or leading/trailing whitespace.

R37-C adds `eval/r37c/src/dsml-codec.mjs`:

```text
encodeDsmlAttribute   escapes \, `, ${, and " in one pass
decodeDsmlAttribute   decodes the same four escapes in one left-to-right pass
parseDsmlStrict       reads tags with a state machine, not a value regex
parameter bodies      preserved byte-for-byte, no trim
direct attributes     decoded once, no trim
```

The invariant is:

```text
Decode(Encode(source)) == source
```

for every supported source. Unknown escapes such as `\n` and a trailing
backslash are preserved as two characters; rewriting them would make the
round-trip lossy.

## 2. Fidelity corpus

`tests/r37c-dsml.spec.ts` covers:

```text
plain text
JavaScript template strings
escaped double quotes
single and double backslashes
Unicode (CJK, accented Latin, emoji)
multiline text
leading/trailing spaces
empty content
JSON with escaped quotes
YAML
Python indentation
Markdown
invoke-like text inside content
```

Both forms are tested:

```text
<parameter name="content">raw body</parameter>
<content="escaped attribute">
```

The direct-attribute form passes all samples. The parameter-body form passes
every sample that does not contain the literal closing parameter tag; content
containing that tag must use the direct-attribute form, and the encoder throws
rather than guessing.

## 3. Ambiguous input

The strict parser refuses to dispatch:

```text
unclosed invoke
parameter with no closing tag
write_file with no content
unknown tool
missing/empty/typed parameter
path escape
nested invoke
```

It records:

```text
truncated-invoke
truncated-parameter
duplicate-parameter
conflicting-parameter
unknown-parameter
empty-invoke
nested-invoke
```

A rejected action is never executed. The harness feeds the rejection back to
the model and continues; the rejection is counted separately from task
failure.

## 4. Source boundary

`analyzeTurnStrict(text, source)` only parses when `source === 'model'`.

```text
tool-result text     no actions; untrusted-source diagnostic
file-content text    no actions; untrusted-source diagnostic
model text           parsed as a model tool request
```

The remaining limitation is real: a model's own prose can contain an exact
DSML example, and the text parser cannot distinguish an example from a
request. The strict parser therefore does not claim the security properties of
a native structured tool-call channel. The production DSH native path is the
long-term answer; P3s is an evaluation protocol.

## 5. Manifest authority

R37-B declared `toolProtocol: P3e` in the manifest but selected the runtime
protocol with `R37_TOOL_PROTOCOL`. R37-C changes the precedence:

```text
manifest.toolProtocol is authoritative
environment may select a protocol only when the manifest omits it
manifest/environment conflict fails preflight with protocol-manifest-mismatch
report records toolProtocolSource = manifest | environment | default
```

`validateManifest` accepts `P0`, `P1`, `P2`, `P3`, `P3e`, `P3s`, and `P4`.
`P3s` is the strict R37-C protocol; `P3e` remains the historical R37-B
protocol so the old result stays comparable.

## 6. Stage 2 no-valid-action attribution

The R37-B summary used 819 completed steps. The traces contain 903 model
calls. Re-parsing every stored turn with P3e gives:

```text
model turns                         903
stored no-valid-action turns        216
stored no-valid-action rate         23.92%
reconstructed no-valid turns        271 (capped trace undercounts actions)
reconstructed rate                  30.01%
```

The reconstructed count is higher because 147 turns are capped at 1,000
characters, so the parser cannot see actions that were beyond the cap. The
stored runtime counter (216) is the better numerator; the trace is the better
denominator (903).

No-action classes from the reconstructed turns:

```text
truncated-output       105
missing-parameter       79
invalid-envelope        51
normal-text-only        36
```

This answers the important question: not every no-valid-action turn is a
parser bug. Some are normal text-only turns; some are truncated provider
output; some are genuinely rejected actions.

## 7. Stage 1 admission deviation

The preregistered Stage 1 criterion was:

```text
P3e turn-level protocol rejection rate <= 10%
```

The implemented gate was:

```text
unparsedTurnRate = truncated-invoke turns / completed steps <= 10%
```

Authoritative Stage 1 numbers:

```text
model turns (completed steps)   569
valid actions                   792
rejected actions                 93
action rejection rate           10.51%
unparsed turns                   29
unparsed turn rate               5.10%
no-valid-action turns           157
no-valid-action rate            27.59%
```

The action-level rate is above 10%; the unparsed-turn rate is below 10%. They
are not the same metric. The archived trace is capped at 1,000 characters, so
the exact turn-level rejection numerator cannot be recovered. The Stage 1
admission is recorded as:

```text
gate-not-verifiable
```

This is a protocol deviation in the historical record, not a retroactive pass.

## 8. Tests

`tests/r37c-dsml.spec.ts` has 12 tests covering the fidelity corpus, escape
decoding, ambiguous input, source boundaries, and conflicting parameters.
`tests/r37c-artifacts.spec.ts` checks that the executed protocol audit reports
903 model turns, 819 completed steps, and `gate-not-verifiable` for Stage 1.
