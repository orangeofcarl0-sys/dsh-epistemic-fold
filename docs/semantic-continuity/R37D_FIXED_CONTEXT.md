# R37-D — Fixed Context

## 1. Two different estimates

```text
E1  end-to-end product effect
    B1 vs S with a real writer, validator, commit, fallback, and rendering
    per cell. This is what R37-B measured.

E2  controlled process effect
    the same frozen context, task, workspace, model, protocol, and budget;
    only the process intervention changes.
```

A fixed-context result is a mechanism result. It is not an EF Active product
effect and must not be reported as one.

The C2 pilot regenerated a writer checkpoint inside every cell. That is a valid
E1-style run, but it is not an E2 experiment: a P0/P1 comparison would inherit
writer variance. R37-D therefore freezes one real checkpoint per case and
context arm.

## 2. Selection rule

Declared before the next live batch:

```text
for each case and context arm:
  take the G0 replicate with the lowest ordinal (r1)
```

```text
guard             G0 (no finish guard)
candidate order   r1, r2, r3
outcome blind     true
```

G0 is the baseline condition. The ordinal is fixed; contract success, task
success, delivery, and test counts are recorded only for audit. G1 candidates
are never selected because the guard belongs to the process experiment, not to
the context.

All six candidates per case/arm are in the manifest (three G0, three G1). The
rule can therefore be checked against every alternative, including the
failures.

## 3. The four fixtures

| case | arm | selected run | chars | delivery | digest |
|---|---|---|---:|---|---|
| B2 | B1 | `B2-B1-G0-r1` | 1,666 | not-applicable | `12dfab6a2f57…` |
| B2 | S | `B2-S-G0-r1` | 2,126 | committed | `e51244857f1e…` |
| D1-v2 | B1 | `D1-v2-B1-G0-r1` | 1,452 | not-applicable | `bdd55d4fab62…` |
| D1-v2 | S | `D1-v2-S-G0-r1` | 1,940 | committed | `1fd0aa9a96a9…` |

The four digests are distinct. B1 and S never share a context.

The S contexts are `committed`, not `full-history-fallback` and not
`semantic-committed-empty`. A fallback or an empty commit would not be a valid
S context for this experiment.

## 4. Fact visibility

The manifest records two views per gold fact:

```text
lexicalInCheckpoint   the visible needle or statement appears verbatim
lexicalInAnchor       an active S anchor contains it verbatim
tokenCoverage         fraction of the fact's content tokens present in the
                      checkpoint or anchors
semanticVisible       tokenCoverage >= 0.75
factVisible           any of the above
```

Selected contexts:

| case | arm | fact | lexical | token coverage | visible |
|---|---|---|---:|---:|---|
| B2 | B1 | `B2-memory` | yes | 0.75 | yes |
| B2 | B1 | `B2-outbox-rejected` | yes | 1.00 | yes |
| B2 | S | `B2-memory` | yes | 0.75 | yes |
| B2 | S | `B2-outbox-rejected` | yes | 1.00 | yes |
| D1-v2 | B1 | `D1-not-run` | no | 1.00 | yes |
| D1-v2 | S | `D1-not-run` | no | 1.00 | yes |

The D1 fact is the interesting case. The gold statement is "The migration code
is written, but its tests have not been run." The B1 checkpoint says
`tests=not-run`; the S anchor says "tests not run". Both preserve the fact, but
neither contains the exact visible needle. A lexical-only check would wrongly
declare the history absent.

The token check is a description, not a semantic proof. The next pilot still
scores the agent's decision against the hidden checker; the manifest only
records that the context carries the evidence.

## 5. Workspace binding

Each case is bound to its real initial workspace:

| case | files | digest |
|---|---:|---|
| B2 | 3 | `9ff3e8d7900c95bd3c96a64c48d900a5a319191c71c6fa75638662a1131bfd34` |
| D1-v2 | 3 | `bb92cdaa4b7b74e16083b73905fe320180acca601fcb4058e918c6309b417363` |

The digest covers sorted path + content for every file under
`eval/*/cases/<case>/workspace`. The next pilot materializes exactly these
files. The C2 final workspaces are not used: they contain the agent's edits.

## 6. Immutability

```bash
node eval/r37d/freeze-fixtures.mjs          # write missing, verify existing
node eval/r37d/freeze-fixtures.mjs --check  # verify only
```

The script refuses to overwrite a `context.txt` whose digest differs from the
selected checkpoint. A fixture change therefore requires a deliberate new
selection, not an edit.

## 7. Limits

- The contexts are real C2 checkpoints, but the selection is made after C2 ran.
  The rule is outcome-blind; the timing is not preregistered.
- The selected contexts are all G0 r1. This is a rule, not a random sample.
- The B1 checkpoint is the model's own compaction summary. Its fact visibility
  is a property of that summary, not of the case alone.
- The D1 fact is preserved by paraphrase. The token check is not a semantic
  entailment check.
- The fixtures are for the next bounded process batch. They do not establish
  an EF product effect.

## 8. Artifacts

```text
eval/r37d/freeze-fixtures.mjs
eval/r37d/fixtures/B2-B1/context.txt
eval/r37d/fixtures/B2-B1/fixture.json
eval/r37d/fixtures/B2-S/context.txt
eval/r37d/fixtures/B2-S/fixture.json
eval/r37d/fixtures/D1-v2-B1/context.txt
eval/r37d/fixtures/D1-v2-B1/fixture.json
eval/r37d/fixtures/D1-v2-S/context.txt
eval/r37d/fixtures/D1-v2-S/fixture.json
eval/r37d/out/fixed-context-manifest.json
tests/r37d-fixtures.spec.ts
```
