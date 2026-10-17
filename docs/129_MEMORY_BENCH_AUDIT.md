# 129 — Memory-pressure bench audit, at the 262K tier

Status: **audit complete. Two defects are real and live; one is withdrawn; the corpus was
regenerated DURING this audit and the report distinguishes both states.**
2026-10-17, repo revision `c9dc2e5` + dirty working tree.

**The bench is being modified concurrently with this audit.** Measured mtimes (ISO, UTC):
`documents.json`, `generation_report.json`, `answer_key.json`, `probes.json` = **03:38:01Z
(11:38:01 local)**; `result_A_quality_logical.json` = **03:30:38Z (11:30:38 local)**. The first
`generation_report.json` I read at ~03:28Z said `"window": 131072`; by 03:38Z it said
`"window": 258048`. Every number below is labelled with which state it came from.

Method: read-only. No bench run, no model call, no file in `eval/memory/` modified. The only file
written is this document. Commands are given with each number.

Superseded scope: an earlier brief for this task named `ef-phase7-logs/.ctxladder*.mjs`; the lead
replaced it. This report covers `eval/memory/` only, per the corrected brief.

---

## Headline

1. **The 262K calibration has already been run, and it collapsed.** `result_A_quality_logical.json`
   (11:30:38 local) records `window: 262144`, `target_tokens: 78643`, one fold, and a surface of
   **11,074 tokens** — 7.1x below the target — reported as `depth_to_target: 1, reached: true`.
2. **That run used the OLD corpus.** It ingested **553,158** tokens, which is the corpus sized for
   131,072 (552,115), i.e. **2.106x** the 262,144 window it claims to test — below the four-times
   floor the design depends on.
3. **The corpus has since been regenerated at 258,048** and now gives **4.141x** at 262,144, which
   clears the floor. So the sizing defect is real but has just been repaired; what remains is that
   **nothing in the run path enforces or checks it** — which is why (2) happened at all.

---

## 1. Sizing: "documents are sized from the window"

### 1a. The mechanism is real — the corpus is window-derived at GENERATION time

`build_corpus.py:362-364`:

    WINDOW = int(os.environ.get("EF_MEMORY_WINDOW", "131072"))
    CORPUS_RATIO = float(os.environ.get("EF_MEMORY_CORPUS_RATIO", "4.2"))
    CORPUS_TARGET_CHARS = int(WINDOW * CORPUS_RATIO * 4)

`render_filler` takes that many characters of `filler_source.txt` (`build_corpus.py:416`) and
partitions them across the 100 documents (`:417-419`). So README's claim is correct in mechanism.
The defect is that **generation and run are decoupled**: `run_cell.py:262` reads the same env var at
run time, but `run_cell.py` **never reads `generation_report.json`** (verified: the only readers are
`tests/memory-corpus-generator.spec.ts:45,51,97` and `tests/memory-tier-sizing.spec.ts:37`). Nothing
compares the corpus on disk with the window being tested.

### 1b. State at 11:30 (the state the recorded calibration ran against)

Command:

    node -e "const d=require('./eval/memory/documents.json');let c=0,n=0;for(const p of Object.keys(d))for(const x of d[p]){c+=x.text.length;n++};console.log(n,c,Math.floor(c/4))"

    100 2208462 552115

`generation_report.json` at that time (and still in `git` HEAD): `window: 131072`,
`corpus_tokens: 552115`, `ratio_achieved: 4.212`, `composition_batch_tokens: 55210`.

| at run window | corpus / window | verdict |
|---|---|---|
| 131,072 | 552,115 / 131,072 = **4.212x** | as designed |
| 262,144 | 552,115 / 262,144 = **2.106x** | **below the 4.0 floor** |

The generator's own predicate would have refused this tier: `build_corpus.py:850`
`(_corpus_tokens >= 4 * WINDOW)` needs 1,048,576 tokens at W=262,144 and the corpus has 552,115.
Runtime confirmation is in the calibration artifact: `ingested_tokens: 553158` against
`window: 262144` = **2.110x** (`result_A_quality_logical.json:4,7`).

### 1c. State at 11:38 (now)

`git diff -- eval/memory/generation_report.json` shows the regeneration: `-window 131072,
-corpus_tokens 552115` / `+window 258048, +corpus_tokens 1085415, +ratio_achieved 4.206`.
Re-measured from `documents.json` (same command as 1b):

    100 4341664 1085416

| at run window | corpus / window | verdict |
|---|---|---|
| 258,048 (recorded) | **4.206x** | as designed |
| **262,144 (the tier you named)** | 1,085,415 / 262,144 = **4.141x** | **clears the floor, with 3.5% margin** |

### 1d. Verdict, and the withdrawal

- **The suspicion "the corpus no longer exceeds 262144 by the intended factor" is WITHDRAWN for the
  current state**: as of 11:38 it exceeds by 4.141x, above the 4.0 floor.
- **The related suspicion "the forced folds disappear" is WITHDRAWN outright, for both states.**
  553,158 tokens already exceeded 262,144 by 2.1x, and the engine's fold threshold is far below the
  ingested size, so ingestion still exceeded the window and folds were still forced. The stale-sizing
  harm was never "no folds"; it was that the corpus sat at the wrong tier (2.1x instead of 4.2x), the
  injection batch was 0.211W instead of ~0.42W, and the generator's own predicate was false.
- **What is still real**: the recorded window (258,048) is not the window you named (262,144), so
  `generation_report.json`'s `ratio_achieved: 4.206` is not the ratio the run will have (4.141), and
  the artifact cannot tell a reader which window the corpus was built for versus which one is being
  tested. Nothing enforces agreement (`run_cell.py` never reads the report), and that is exactly how
  the 11:30 run came to calibrate a 2.1x corpus against a 262,144 target.

---

## 2. The target fraction, and whether 262,144 can reach it

`run_cell.py:481`: `ap.add_argument("--target-frac", type=float, default=0.30)`.
`run_cell.py:262-263`: `window = int(os.environ.get("EF_MEMORY_WINDOW","131072"))`;
`target = int(window * target_frac)`.

At `EF_MEMORY_WINDOW=262144`: **target = 262,144 x 0.30 = 78,643 tokens.**

**Budget: reachable, comfortably.** With the current corpus (batch 108,540):

    probe turn = (78,643 + 108,540 + 10,000) x 1.05 + 8,192 = 215,234 = 0.821 x W   <- fits
    fold turn  = (78,643 +  2,000)            x 1.05 + 32,768 = 117,443 = 0.448 x W   <- fits

(Arithmetic from `build_corpus.py:382-389, 846-848`; recomputed here with `node -e`.) The probe turn
is the binding case at 0.821W, so the target is affordable at this tier.

**As a STATE: reachable only if the ENGINE's window is raised too.** The post-fold surface is bounded
below by the engine's retention, which is a fraction of the **engine's** window, not of
`EF_MEMORY_WINDOW`: `retainTokens = messageBudgetTokens * retainRatio` (`src/policy.ts:474`),
`DEFAULT_RETAIN_RATIO = 0.16` (`src/policy.ts:194`), and the `quality` arm takes
`QUALITY_RETAIN_RATIO = BALANCED_RETAIN_RATIO = 0.24` (`src/preset.ts:150,160,286`). The engine's
window is `EF_TAU2_WINDOW` (`eval/tau2/bridge-host.ts:131`, **default 32,000**), wired into the
adapter at `:1676-1680`; the fold threshold is `thresholdRatio` 0.5 (`:1764`) applied as
`min(contextWindow * ratio, messageBudgetTokens)` (`src/policy.ts:469-472`).

    engine window 32,000  -> threshold 16,000, retain 7,680   -> target 78,643 unreachable
    engine window 262,144 -> threshold 131,072, retain 62,914 -> target reachable in principle

`eval/memory/run-memory.sh` sets **neither** window variable (its exports are the route, key,
headers and stderr only, `:24-34`), and `EF_MEMORY_WINDOW` is **read** in exactly two places
(`run_cell.py:262`, `build_corpus.py:362`; elsewhere it appears only in README/docs and one test
assertion, `tests/memory-driver-order.spec.ts:140`). So setting
`EF_MEMORY_WINDOW=262144` alone does not raise the engine's window.

---

## 3. `--calibrate`: what happens when the target is not reached

`run_cell.py:265-274`: up to `--max-depth` (default 40, `:465`) `bridge.compact()` attempts, breaking
when `committed and (t.get("promptTokensLast") or 0) <= target` (`:273`).

If the target is never reached: `reached = []`, so `depth_to_target = None` (`:281`) and
`reached = False` (`:284`). `main()` prints `depth_to_target=None reached=False` (`:498`) and then
**exits 0**, having written the result file (`:493-494`).

**Withdrawn:** `depth_to_target: null` is **not** silently turned into depth 0. Grep over the whole
repo for `depth_to_target` returns only `run_cell.py:281,498` and the stored artifact — nothing
consumes it, so there is no coercion. The real defect is weaker but real: a failed calibration is
exit-code- and filename-indistinguishable from a successful one, and no guard refuses a subsequent
cell run.

**A second, checkable defect in the same code:** `--calibrate` and a mode-A cell write the **same
filename**. `run_cell.py:493` builds `result_{args.mode}_{args.arm}_{args.order}.json` and
`--mode` defaults to `"A"` (`:462`), which is why the calibration output on disk is named
`result_A_quality_logical.json` although it contains `sweep`/`depth_to_target`/`reached` and no
`cell` or `score` block. A later `--mode A --arm quality --order logical` run overwrites the
calibration record.

---

## 4. Hard-coded window assumptions in `eval/memory/*.py`

`grep -n "131072|131,072|131k|131_072|WINDOW|window" eval/memory/*.py`

| site | text | verdict |
|---|---|---|
| `run_cell.py:262` | `os.environ.get("EF_MEMORY_WINDOW", "131072")` | the knob, correctly read; a 262K run that forgets the env var silently measures 131K. The artifact records `window`, so it is detectable after the fact |
| `run_cell.py:135` | "Ten documents is about 86k tokens, which fits a 131k window" | **stale**: the batch is 55,210 tokens in the 131K state and 108,540 in the current one; "86k" is neither. Comment only |
| `run_cell.py:131-132`, `:375` | "the entire corpus -- 100 documents, 861,703 tokens" | **stale**: measured 552,115 (131K state) / 1,085,415 (now). Comment only, but it is the number an operator would size a tier from |
| `run_cell.py:339` | "The corpus is more than four times the window (3.2.5)" | an assumption stated as fact; true at 131K/4.212x, false for the 11:30 run at 262K (2.106x) |
| `run_cell.py:467` | "172,339 tokens against a 131,072-token window" | historical rationale, correct as history |
| `build_corpus.py:362` | `WINDOW = os.environ.get("EF_MEMORY_WINDOW","131072")` | same knob as `run_cell.py:262`; the two must agree and nothing checks it |
| `build_corpus.py:850` | `_corpus_tokens >= 4 * WINDOW` | the correct guard — but it runs at GENERATION only, never against the run's window |
| `build_corpus.py:844` | `_corpus_tokens = sum(len(d["text"])) // 4` | the report's `corpus_tokens` is a chars/4 **estimate**; the real ingested count was 553,158 vs 552,115 = 1.002x, so the 1.05 `TOKENIZER_SLACK` (`:384`) is conservative. Not a defect |
| `build_filler_source.py:7`, `build_corpus.py:330-331` | "16,240 tokens -- 12.4% of the window", "50%-of-window calibration target" | historical; the 50% figure is also stale (see below) |

Outside `.py`, the same staleness: `README.md:29` says `--calibrate` reaches "50% of the window"
while the default is 0.30 (`run_cell.py:481`); `README.md:91,93` say 591,437 tokens / 4.51x and a
59,150-token batch (the pre-regeneration numbers); `README.md:112-124` tabulates ratio 4.5 and a
"252K = 258,048" tier while `build_corpus.py:363` defaults to 4.2. `tests/memory-tier-sizing.spec.ts`
cannot catch any of this: it asserts against `generation_report.json` (the generation-time window,
`:37-52`) and its own tier derivation hard-codes `SURFACE = 0.5` and `ratio = 4.5` (`:84-86`), so it
is an arithmetic identity, not a check on the artifact.

---

## 5. Not established

- **Which engine window the 11:30 calibration actually used.** The artifact does not record
  `EF_TAU2_WINDOW`. The bound is inferential: the observed post-fold surface of 11,074 must be at
  least the engine's retention, `0.24 x W_engine`, so **W_engine <= 46,142** — i.e. it was not
  262,144. At the 32,000 default the prediction is retain 7,680 and a landing near 11,074, which
  matches. This is a bound, not a read.
- **Whether the 78,643 target is reachable in practice with `EF_TAU2_WINDOW=262144`.** Retention
  alone (62,914) is below the target, so a landing inside (62,914, 78,643] is possible — but whether
  one fold lands there is a live measurement, not something I ran.
- **Whether the 11:30 artifact was produced by you or by a teammate.** It is untracked
  (`git status --porcelain` -> `?? eval/memory/result_A_quality_logical.json`) and its schema is
  exactly `run_calibration`'s return dict (`run_cell.py:277-285`), so it is a real calibration, but I
  did not observe the invocation.
- **The disambiguation 0/80 in `last_score.json`** (02:26 local, before the regeneration) while
  extraction, composition, abstention and update are 1.0. That is a striking pattern and is *not*
  covered by the four questions; I am flagging it, not diagnosing it.
- **Quota consumption by a rejected request** — that belonged to the superseded ladder brief and is
  not re-examined here.

---

## 6. Minimal fixes (ours; none applied)

1. **Set `EF_TAU2_WINDOW` alongside `EF_MEMORY_WINDOW`, and record both.** The target is a fraction
   of one window and the compression is a fraction of the other. Minimal form: have
   `run_calibration`/`run_cell` write `engine_window: os.environ.get("EF_TAU2_WINDOW")` into the
   result, and have `run-memory.sh` export `EF_TAU2_WINDOW="${EF_TAU2_WINDOW:-$EF_MEMORY_WINDOW}"`.
   Without it, a 262K run folds at the 32,000 default and the 78,643 target is unreachable as a state.
2. **Make the calibration refuse an overshoot instead of reporting it as success.** `run_cell.py:273`
   accepts any surface `<= target`; record `overshoot_frac = 1 - tokens/target` and set
   `reached = False` (or a distinct `collapsed`) when the first committed fold lands below, say,
   `0.5 x target`. The 11:30 run would have been reported as a collapse rather than `reached: true`.
3. **Check the corpus against the run window at start-up.** Compare
   `generation_report.json["sizing"]["window"]` with `EF_MEMORY_WINDOW` and either refuse or print
   both plus the recomputed ratio. This is the guard whose absence produced the 11:30 run.
4. **Give `--calibrate` its own output filename** (e.g. `calib_{arm}_{order}.json`) so a mode-A cell
   cannot overwrite the calibration record.
5. **Decide the tier deliberately: 258,048 or 262,144.** The corpus is built for 258,048 (4.206x); at
   262,144 it is 4.141x — above the floor with 3.5% margin. Either run at 258,048, or regenerate at
   262,144 (the pool is 7,398,971 chars, which supports windows to ~440,414 at ratio 4.2 per
   `build_corpus.py:364,399-404`).
