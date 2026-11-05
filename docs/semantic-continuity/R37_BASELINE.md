# R37 — Baseline

## Repository

| field | value |
|---|---|
| Repository | `orangeofcarl0-sys/dsh-epistemic-fold` |
| R37 worktree | `F:\Codex_Work_Space\DSH plugin\ef-r37-action` |
| Branch | `rc37-semantic-action` |
| Base commit | `b8274bba8b2a974e9c75af283e415e61a650295e` (R36 HEAD) |
| R37 HEAD at manifest time | `b8274bba8b2a974e9c75af283e415e61a650295e` |
| R36 worktree | `F:\Codex_Work_Space\DSH plugin\ef-r36-interface` (`rc36-semantic-interface`) |
| R36 worktree status | clean |
| Primary worktree | `F:\Codex_Work_Space\DSH plugin\dsh-epistemic-fold` |
| Push | not authorized, not performed |

Status at manifest time:

```text
?? docs/semantic-continuity/R37_BASELINE.md
?? eval/r37/
```

## Environment

| field | value |
|---|---|
| Node | `v24.14.1` |
| Platform | `win32 x64` |
| package-lock sha256 | `e62fdfcc1ebd261e4ac166f2a682b27cb1ec901007e01cb9af08c42e18c25447` |
| node_modules | present |
| lib built | yes |
| eval/live/dist built | yes |
| vendor/deepseek-harness | absent |

Build commands: `npm ci`, `npm run build`, `npm run eval:build`.

## Dataset

```text
datasetId             r33-semantic-continuity-v2
dataset digest        407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
frozen digest         407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
matches frozen        true
scorer                v3
case count            17
```

The six behavioural cases used by R36:

| case | digest | workspace files |
|---|---|---:|
| A1 | `642bd3c1f93e550c…` | 4 |
| B2 | `4a7c173eac9cd8a2…` | 3 |
| C1 | `c62af2d52cf8cae2…` | 3 |
| D1 | `1422d9207af5c9a5…` | 3 |
| F1 | `f9e09e24c0cb9171…` | 3 |
| H1 | `f80d08ac6010d6a9…` | 3 |

## R36 evidence identity

The R36 worktree is not copied and is not modified. These are content digests of
the authoritative files used by R37:

| file | sha256 (prefix) | bytes |
|---|---|---:|
| `eval/r36/out/gate-status.json` | `981b5d882e99a385…` | 16162 |
| `eval/r36/out/causal-comparison.json` | `62588877e01e906f…` | 34006 |
| `eval/r36/out/live-results.json` | `79e0d5f4087c66ef…` | 83344 |
| `eval/r36/out/conditions.json` | `1b71429cb3824055…` | 8796 |
| `eval/r36/out/harness-calibration.json` | `efe2dd3f895ee39b…` | 29869 |
| `eval/r36/out/live-writer-analysis.json` | `5cca9a57b7bd0b06…` | 31653 |
| `eval/r36/out/parser-ablation.json` | `5fde25f248d202bf…` | 28805 |
| `eval/r36/out/case-certification.json` | `4c3064e4425d8e28…` | 7098 |
| `eval/r36/evidence/r35/writer-audit.json` | `a00ea291bf4f7ebf…` | 66496 |
| `eval/r36/evidence/r35/continuation-writers.json` | `6c4ea9f2f86ffa5e…` | 154547 |
| `eval/r36/manifests/b1-s-o1-o2-frozen.json` | `696c81082ad4559d…` | 1400 |
| `eval/r36/manifests/h-combined-o2.json` | `5e00619315997998…` | 1199 |
| `eval/r36/manifests/h-finish-o2.json` | `22b1e6098cf67458…` | 1216 |
| `eval/r36/manifests/h-native-o2.json` | `98d7171cc332fa0b…` | 960 |
| `eval/r36/manifests/h-output-o2.json` | `b95c4828b9ae5144…` | 1106 |
| `eval/r36/manifests/h-protocol-o2.json` | `7304f38ddf50feb4…` | 1212 |
| `eval/r36/manifests/h-step-o2.json` | `420434803653ca86…` | 1201 |
| `eval/r36/manifests/h0-o2.json` | `e0927d3edb3a1a0d…` | 1068 |
| `eval/r36/manifests/w0-p0-live-control.json` | `84af2e19a3fdb817…` | 970 |
| `eval/r36/manifests/w0-p0-replay.json` | `2954695554f34de1…` | 865 |
| `eval/r36/manifests/w0-p1-replay.json` | `2cd707c506d487fb…` | 873 |
| `eval/r36/manifests/w1-p0-live.json` | `5b15c5ee89e53e4b…` | 961 |
| `docs/semantic-continuity/R36_AGENT_CALIBRATION.md` | `6a9f5f1c8712ddf3…` | 9098 |
| `docs/semantic-continuity/R36_BENCHMARK_VALIDITY.md` | `c5eea059cb25ed69…` | 8872 |
| `docs/semantic-continuity/R36_CAUSAL_COMPARISON.md` | `5d81f4ba3c748ff8…` | 7369 |
| `docs/semantic-continuity/R36_COST_REPORT.md` | `f33042d30318ae09…` | 5190 |
| `docs/semantic-continuity/R36_DECISION.md` | `6687f4a015e09aaf…` | 8304 |
| `docs/semantic-continuity/R36_FAILURE_ATTRIBUTION.md` | `97ffa4495db10cc2…` | 10833 |
| `docs/semantic-continuity/R36_HANDOFF.md` | `edc4d90d7c6874bb…` | 10626 |
| `docs/semantic-continuity/R36_R35_EVIDENCE_AUDIT.md` | `1ef82fc0778f3e72…` | 9815 |
| `docs/semantic-continuity/R36_WRITER_ABLATION.md` | `5ccec69128c5ff05…` | 6790 |
| `docs/semantic-continuity/R36_WRITER_CONTRACT.md` | `3ec83b4f25e98cd2…` | 6251 |

The run archive is referenced by digest in
`eval/r37/out/baseline-manifest.json`. It contains
**60 report.json**, **109 trace records**,
**12 verification.json** files and
**118 final workspace files** across the whole R36 archive.
The 12 causal runs are traced individually, including each arm's final
workspace, bundle tree and journal tree.

## Test baseline

| command | exit | summary | duration | timed out |
|---|---:|---|---:|---|
| npm run typecheck | 0 | - | 22695 ms | no |
| npm run eval:r33 | 0 | Tests  94 passed (94) | 39184 ms | no |
| npm run eval:r36-tests | 0 | Tests  34 passed (34) | 9422 ms | no |
| npm run test | 1 | Tests  12 failed | 1476 passed | 70 skipped (1558) | 209642 ms | no |

The test run changed the worktree. Those changes are recorded in the manifest as `statusAfterTests` and are not part of any R37 commit.

## Known baseline failures

The R36 baseline recorded 12 full-suite failures: four need the absent
`vendor/deepseek-harness` checkout, and eight are installed-vs-vendored DSH
differences. R37 distinguishes those from new R37 failures by command and test
file; it does not repair unrelated vendor drift.

## Caveats

- R36 did not record a per-run git SHA or writer finish reason. `null` is used
  rather than an inferred value.
- F1's initial raw writer output was lost in R35; it is not reconstructed.
- The R36 causal run archive is local and gitignored. Its digest identifies the
  bytes actually read; it is not a second copy of the data.
- `cordis.patch.yml` is regenerated by `npm ci`/prepare because the installed
  DSH line differs from the vendored line. It was restored to the tracked bytes
  before this manifest was written.
