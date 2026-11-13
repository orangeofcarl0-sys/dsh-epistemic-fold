# EF-R3 product-lane pilot — trajectory and model-behaviour analysis

This is a per-cell reading of the 18-cell product-lane pilot (`e2e-r3-product-pilot-1`). The aggregate result is B0 5/6, E1 3/6, E0 1/6. The aggregate is real, but it is not a clean quality comparison. This document explains what the model actually did, where the checkpoints helped, where they did not, and which confounds must be removed before the next live experiment.

The machine-readable companion is `eval/r3/out/product-pilot-trajectory-analysis.json`; the generated table is `product-pilot-trajectory-analysis.md`.

## 1. Method

- The **live portion** starts at the user message carrying the task prompt. The seeded history is excluded from the live tool counts.
- Tool counts are live `tool/call` events. Recall/search means `context_recall` + `context_search`; read/list means `read_file` + `list_dir`; write/edit means `write_file` + `edit_file`.
- `witness` is the compaction witness: attempts, committed, refused, aborted, committed-and-delivered. It is separate from the live tool sequence.
- A **step-limit** cell is one whose termination is `step-limit`; the report's `finalText` is usually empty because the model never produced a final answer.
- The final checkpoint is the one on the surface at report time. The rationale checkpoint text is quoted where it matters.

## 2. Per-cell table

| Cell | Arm | Result | Term | Witness (commit/refuse/abort/deliver) | Live shape | Key behaviour |
|---|---|---|---|---|---|---|
| T11-p1-B0-r1 | B0 | pass | finish | 1/4/0/1 | 4 folds, 0 recall, 5 read/list, 2 write; `result.json={"failed":3}` | Read the baseline, fixed the cap, tested, wrote the correct count. |
| T11-p1-E0-r1 | E0 | fail | step-limit | 4/0/0/4 | 3 folds, 8 recall, 7 read/list, 0 write | Marker-only checkpoint; recall loops; no `result.json`. |
| T11-p1-E1-r1 | E1 | fail | step-limit | 1/0/0/1 | 0 live folds, 0 recall, 7 read/list, 2 write; `result.json={"failed":1}` | Checkpoint says **3**; model ran the *current* suite, saw 1 failure, wrote 1, fixed code, called `finish`. |
| T12-p1-B0-r1 | B0 | pass | finish | 1/0/0/1 | 0 folds, 0 recall, 3 read/list, 1 write; `config.json` 2/5 | Checkpoint carried the baseline; direct write. |
| T12-p1-E0-r1 | E0 | fail | step-limit | 6/0/0/5 | 5 folds, 11 recall, 5 read/list, 0 write | Marker-only checkpoint; recall loops; no `config.json`. |
| T12-p1-E1-r1 | E1 | pass | finish | 1/0/0/1 | 0 folds, 0 recall, 3 read/list, 1 write; `config.json` 2/5 | Rationale carried the exact baseline; direct write. |
| T13-p1-B0-r1 | B0 | pass | finish | 1/0/0/1 | 0 folds, 0 recall, 0 read/list, 1 write; `build.json` beta/7f3c9a1e | Checkpoint carried the manifest; direct write. |
| T13-p1-E0-r1 | E0 | fail | step-limit | 5/0/0/5 | 4 folds, 11 recall, 3 read/list, 0 write | Marker-only checkpoint; recall/search loops; no `build.json`. |
| T13-p1-E1-r1 | E1 | pass | finish | 1/0/0/1 | 0 folds, 0 recall, 3 read/list, 1 write; `build.json` beta/7f3c9a1e | Rationale carried the manifest; direct write. |
| T14-p1-B0-r1 | B0 | pass | finish | 4/2/0/3 | 5 folds, 0 recall, 7 read/list, 1 edit; limit 4 | Corrected value applied and tested. |
| T14-p1-E0-r1 | E0 | pass | finish | 1/0/0/1 | 0 folds, 1 search, 5 read/list, 1 edit; limit 4 | The only E0 pass: the fact survives in the retained tail / one search; no recall loop. |
| T14-p1-E1-r1 | E1 | pass | finish | 1/0/0/1 | 0 folds, 0 recall, 4 read/list, 1 edit; limit 4 | Rationale carried the correction; direct edit/test. |
| T15-p1-B0-r1 | B0 | pass | finish | 2/2/3/1 | 6 folds, 0 recall, 5 read/list, 1 write; concurrency 6 | Correct value, despite 3 aborted Basic summaries. |
| T15-p1-E0-r1 | E0 | fail | step-limit | 5/0/0/4 | 4 folds, 9 recall, 4 read/list, 0 write | Marker-only checkpoint; recall loops; no `effective.json`. |
| T15-p1-E1-r1 | E1 | fail | step-limit | 3/0/0/3 | 2 folds, 6 recall, 5 read/list, 0 write | Rationale describes the method, **not the value 6**; recall/list loops; no write. |
| T16-p1-B0-r1 | B0 | fail | finish | 1/0/4/1 | 4 folds, 0 recall, 12 read/list, 1 write; `{"id":"rel-p1"}` | 4 Basic summaries aborted at the 1024 cap; wrong key (`id` vs `release`); only 1 compaction vs the task's 2. |
| T16-p1-E0-r1 | E0 | fail | step-limit | 7/0/0/7 | 6 folds, 16 recall, 16 read/list, 0 write | Marker-only checkpoints; heavy recall/read loops; no `release.json`. |
| T16-p1-E1-r1 | E1 | fail | step-limit | 6/0/0/6 | 5 folds, 5 recall, 20 read/list, 0 write; 21 requests, 1 unknown usage | Rationale describes the extraction method, **not the release id/checksum**; logs read from `logs/` are ENOENT; no write. |

## 3. The four distinct failure mechanisms

### 3.1 E0: marker-only checkpoints → empty recall → no write

All five E0 failures have the same shape:

- the final checkpoint is the 47-character marker `[EF1 L cp:…]`;
- the model calls `context_recall`/`context_search` repeatedly;
- the recall page reports `summaryAvailable: false`;
- a new compaction starts during the loop;
- the model never writes the required file, and the 8-step limit stops it.

T14 is the exception: its fact stays in the retained tail, one search is enough, and the model writes `src/limit.js` and passes. This is consistent with the R2 finding that marker-only checkpoints leave the model unable to recover facts; the product preset E0 is an isolation arm, not a product tier.

### 3.2 E1 T11: the checkpoint is correct, but the model trusts the wrong source

The E1 T11 checkpoint explicitly says:

> Authoritative line: `… failed=3` … Report **3 failures** … that is the number to quote, not the count of visible ERROR lines.

The live trace shows the model listing the workspace, reading `package.json`, `src/retry.js` and `test/retry.test.js`, then running `node --test`. That current suite has **1 failing test** (the existing test expects the batch cap to be 2; the source still returns 5). The model then:

1. says “Pre-change run: **1 failure**”;
2. fixes `src/retry.js`;
3. re-runs the suite (passes);
4. writes `result.json` with `{"failed":1}`;
5. calls `finish`.

The checkpoint was delivered (1/1 committed and delivered). The failure is a **model trust/instruction-following failure**: it preferred a fresh run of the *current* test suite over the folded baseline evidence, even though the checkpoint warned that the visible test-level count is not the baseline count. This is not a checkpoint absence or a delivery failure.

### 3.3 E1 T15/T16: the rationale is methodological prose, not the answer

The E1 T15 checkpoint describes why timestamps rather than file order govern the revision, and says “Anchors for the specific decisions and constraints are in the machine sections.” It does **not** state the concurrency value `6` that the task asks for. The model then:

- searches and recalls checkpoint pages;
- lists `logs/` (ENOENT) and reads `README.md`;
- folds again during the recall attempts;
- never writes `effective.json`.

The E1 T16 checkpoint describes how to enumerate shards and why first-write-wins is correct, but it does **not** contain the release id `rel-p1` or the checksum. The model then:

- reads `logs/` (ENOENT) and the README;
- recalls the checkpoint pages;
- folds again;
- after stage B, the stage logs are on the surface, but it folds them away and then tries to read `logs/deploy-stage-*.log` (ENOENT);
- never writes `release.json`.

These are **rationale content failures**, not delivery failures. The rationale writer can produce a long, coherent essay about method while omitting the concrete fact the task needs. T12/T13/T14 show the other side: their checkpoints state the exact baseline/manifest/correction, and the model writes directly and passes. The difference is not “rationale on/off”; it is whether the rationale carries the answer.

### 3.4 B0 T16: Basic summary truncation + task schema + mechanism check

B0 T16 is a different failure:

- Basic attempted 5 compactions: 1 committed, **4 aborted** with “summarization truncated at the token cap”;
- the surviving summary is the generic Basic checkpoint (2341 chars), not a compacted release record;
- the model wrote `{"id":"rel-p1","checksum":"9f2a7c14"}` instead of `{"release":"rel-p1",…}`;
- the task's checker also requires `minCompactions: 2`; B0's witness has 1 committed compaction, so it fails that check as well.

Three confounds are visible here:

1. **Basic's summary cap is 1024 output tokens**, which is too small for the 32k/long-log T16 payload. The R2 stress lane used 1024 at 16k; at 32k the Basic summaries truncate. B0 is therefore not a fully product-representative baseline in this cell.
2. **The task schema is ambiguous**: “write `release.json` with the `release` id and `checksum`” can reasonably be read as `{"id":…}`. The model chose `id`; the checker expects `release`. A fair task should state the exact key.
3. **`minCompactions: 2` is a mechanism check designed for EF's multi-fold task, applied to B0.** Native Basic has a different compaction policy and only committed one fold. The checker conflates task correctness with mechanism exposure. For a cross-arm quality comparison, the task check and the mechanism check must be reported separately.

## 4. The recall → fold loop

The live traces repeatedly show:

```
assistant → context_recall / context_search
          → compaction/start
          → compaction/end
          → assistant → context_recall / context_search
```

Examples:

- E0 T11: 8 recall/search calls, 3 live folds; the final checkpoint is the 47-char marker.
- E0 T12: 11 recall/search, 5 live folds; no `config.json`.
- E0 T13/T15: 11/9 recall/search, 4 live folds each.
- E1 T15: 6 recall/search, 2 live folds; no `effective.json`.
- E1 T16: 5 recall/search, 5 live folds; no `release.json`.

The sequence is consistent with a **retrieval-driven compaction loop**: recall adds messages to the surface, the surface crosses the threshold, the fold replaces the retrieved messages with a new checkpoint, and the model recalls again. The model is not merely slow; it is in a non-convergent loop. The 8-step limit is the proximate stop, not the root cause. The loop is visible in both the marker-only arm and the rationale arm, so it is not specific to E0.

This is a mechanism-level finding for the product preset: retrieval results are not protected from the fold that immediately follows them. A candidate fix (protect recall results, or include retrieved evidence in the next checkpoint) must be tested separately; it is not a default change.

## 5. What the pilot result does and does not say

### Supported

- In this harness, at 32k, with 6 tasks and 1 replicate: **B0 5/6, E1 3/6, E0 1/6**.
- E1 has **0 tasks that B0 fails** and B0 has 2 tasks that E1 fails (T11, T15; T16 both fail).
- E1's compaction commits are delivered: **13/13**. E0: 28 commits, 26 delivered. B0: 10 commits, 8 delivered.
- The E1 failures are **not delivery failures**. They are:
  - T11: wrong source (current tests instead of folded baseline);
  - T15: rationale lacks the concrete value;
  - T16: rationale lacks the release id/checksum and the model folds away the stage logs.
- E0's failures are marker-only recall loops; E0 is an isolation arm, not a product tier.
- B0's T16 failure is Basic summary truncation + schema ambiguity + the multi-fold mechanism check.
- The pilot does **not** support a product candidate. Deployment Hold remains.

### Not supported

- **“Native Basic is intrinsically better than E1.”** The pilot is 8-step censored (E0 5/6, E1 3/6 step-limited; B0 0/6), the task logs are not in the workspace, Basic's summary cap is 1024, and T16's mechanism check applies to B0. These are harness/task confounds, not a clean quality comparison.
- **“E1 is cheaper.”** E1's output is lower partly because its step-limit cells never produce a final answer. E1's uncached input is +159,347 tokens over B0 in the recorded pairs. The cost-valid subset is 5 pairs. Do not claim a cost advantage.
- **“The 18-cell result generalizes to the product.”** n=6 per arm, one model/route/machine, one replicate, and the step-limit/task-design confounds above.

### The honest summary

The pilot is a **negative/neutral signal for E1 in this harness**, not a proof that B0 is better. It shows that the shipped economy preset, as run here, does not yet deliver a quality advantage over native Basic; it also shows that the dominant failure modes are model trust of folded evidence, rationale content that omits the answer, and a recall→fold loop under an 8-step limit. Those are fixable experimental/mechanism questions, not a final product verdict.

## 6. The next experiment must remove the confounds

Do not expand to the 72-cell lane. The next live experiment should be a **step-limit and task-design sensitivity pilot**:

1. **Step limit**: same 6 tasks, `maxSteps` 12/16, all three arms. If EF passes more with a higher limit, the 8-step cap was the binding constraint. Record the number of steps each arm needs.
2. **Log placement**: either put the `logs/*.log` files in the workspace, or state in the task/README that the logs exist only in folded history and must be recovered with recall. Eliminate the `read_file`/`list_dir` ENOENT loops before comparing quality.
3. **Separate task correctness from mechanism exposure**: report the checker result and `minCompactions` separately. Do not fail B0 on a multi-fold mechanism count in a cross-arm quality table.
4. **Basic summary cap**: at 32k, 1024 output tokens truncates long-log summaries. Freeze a product-representative Basic config (or raise the cap) before the next comparison.
5. **Rationale content contract**: require the rationale to state the concrete fact(s) the task needs, not only the method. T15/T16 are the minimal test cases: the checkpoint must contain the concurrency value / release id and checksum.
6. **Recall→fold loop**: test a candidate that protects recalled messages from immediate folding, or includes the retrieved evidence in the next checkpoint. This is a mechanism candidate, not a default change.
7. **T16 task**: state the exact JSON schema (`release`, not `id`) and decide whether the task is a correctness task or a multi-compaction mechanism task; do not conflate them.

Only after these are fixed should the 54/72-cell product lane be considered. The old 54-cell stress confirm remains terminated-partial; it is not reopened.

## 7. Evidence

- `eval/r3/out/product-pilot-trajectory-analysis.json` — per-cell structured data: live tool counts, checkpoint text, written files, last events.
- `eval/r3/out/product-pilot-trajectory-analysis.md` — generated per-cell table and reading.
- `eval/r3/out/product-pilot-analysis.json` / `.md` — aggregate arms, pairs, cost, decision.
- `eval/r3/out/health-probe-analysis.md` — 16/16 transport/usage, p95 82,290 ms, latency caveat.
- `eval/r3/out/research-archive-r3-product-pilot.json` — 245 files / 37.8 MB / 0 credentials / primary and E: verified.
- `docs/convergence/EF_R3.md` — round report and gates.
