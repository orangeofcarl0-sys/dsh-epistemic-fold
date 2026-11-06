# R37-C — Baseline

## 1. Repository state

```text
Repository        orangeofcarl0-sys/dsh-epistemic-fold
R37-B HEAD        5ef67814a4ec8fd8bcca362b89ad338acd0a8ae0
R37-C branch      rc37c-measurement-closure
R37-C worktree    F:/Codex_Work_Space/DSH plugin/ef-r37c-closure
R37-B worktree    F:/Codex_Work_Space/DSH plugin/ef-r37-action (clean, untouched)
```

The R37-C worktree was created with `git worktree add -b
rc37c-measurement-closure ... 5ef6781`. No existing worktree, branch, R36/R37
artifact, or user change was reset, cleaned, or overwritten.

The primary worktree remained on `rc29-working-set-observer` at `7a42ec6` and
was not modified.

## 2. Build and baseline tests

Run in the new worktree:

```text
npm ci                         pass
npm run eval:build             pass (3 eval modules)
npm run typecheck              pass (src, client, eval)
npm run eval:r37-tests         49/49 pass
npm run eval:r36-tests         34/34 pass
```

The full suite is run again at the end of R37-C; it is not a C0 gate.

## 3. Raw evidence

The R37-B raw archive is gitignored and lives only in the R37-B worktree. It
was read in place, never moved or rewritten.

```text
eval/r37/runs-b          9.2 MB, 1,572 files
eval/r37/manifests-b     700 KB, 165 files
eval/r37/runs-b2         13 MB, 2,111 files
eval/r37/manifests-b2    920 KB, 218 files
```

Inventory:

```text
run reports               381
run rows                  381
files hashed              2,919
bytes hashed              17,449,050
Stage 1 reports           163
Stage 2 reports           218
Stage 2 unique cells      216
Stage 2 retry reports     2
```

The two Stage 2 retries are `r37b-rep-B2-FN-r2-retry1` and
`r37b-rep-C1-FH-r1-retry1`. They are duplicate cells for outcome analysis and
remain counted in cost.

## 4. Cell matrix

Expected cells were derived from the frozen manifests, not from the summary
JSON:

```text
Stage 1 manifests         167 (21 duplicate keys from reruns)
Stage 1 unique cells      144
Stage 2 manifests         216
Stage 2 unique cells      216
Total unique expected     360
Total unique observed     360
Missing                    0
Unexpected                 0
Manifest/report drift      0
```

Stage 1's summary was generated from 158 reports; the archive now contains 163.
The five later reports are retry reports. This is recorded as a summary/archive
difference, not as a missing cell.

Configuration across every Stage 2 report:

```text
model             deepseek-v4.1-flash
tool protocol     P3e
harness           H-protocol-e
finish guard      false
runtime           custom-json-loop
dataset digest    99b30426c3dab71521ee47e0d2e6fcd61b33fdfd9a26b5b8516fc1fef7bbb3c2
scorer version    3
route env names   R37B_BASE_URL / R37B_API_KEY
```

No report declares a different model, protocol, harness, dataset digest, or
scorer version.

## 5. Invalid rows

Stage 2 has 11 rows with `valid: false`:

```text
provider-transport-error    2
fold-invalid                9
```

The nine fold-invalid rows are writer-only rows whose summary was not smaller
than the shadowed span. They are observable pipeline outcomes, not censored
provider measurements. This distinction is the subject of
`R37C_METRIC_CORRECTION.md` and `R37C_R37B_AUDIT.md`.

## 6. Truncated evidence

The R37-B trace stores model turn text capped at 1,000 characters. 113 Stage 2
rows contain at least one capped turn. These rows are marked
`truncated-evidence`; a capped prefix is never treated as the complete model
response.

## 7. Artifacts

```text
eval/r37c/out/baseline.json
eval/r37c/out/evidence-inventory.json
eval/r37c/out/evidence-integrity.json
```

`evidence-inventory.json` records every file's SHA-256 and size, the report and
manifest hashes, the model/protocol metadata, and the archive hash.
`evidence-integrity.json` records the cell matrix, configuration drift, invalid
rows, truncated rows, and the secret scan.

## 8. What C0-A does not claim

- It does not re-run the R37-B model calls.
- It does not turn a fold refusal into a provider failure.
- It does not claim the Stage 1 summary is complete: it is five reports behind
  the archive.
- It does not claim the 1,000-character trace is a full response.
