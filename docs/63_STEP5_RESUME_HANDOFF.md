# 63 — Step-5 Resume Handoff

Written 2026-10-13 while the provider was rate-limiting `step-5-preview-free`. Everything is
halted on purpose. This document exists so that work resumes **without re-deriving anything and
without repeating the mistake it records**.

Read [§3](#3-what-went-wrong-and-what-was-reverted) before touching a model name.

---

## 1. State at the time of writing

| item | value |
|---|---|
| HEAD | `4730469` — revert of the model switch |
| containers | **0** |
| orchestrator processes | **0** |
| background jobs | **0** |
| test suite | 103 files, 1063 tests, 0 failures |
| memory suite | 10 files, 52 tests, 0 failures |

Nothing is running. Nothing will restart on its own: the wave is launched by `ef-ucs.sh`, which
spawns four `ef-phase7.sh sweep-ucs` children, and all of those were killed. Stopping the
**containers alone is not enough** — the orchestrators respawn them. Kill the process tree.

---

## 2. Route and credential

| item | value |
|---|---|
| base URL | `https://opencode.ai/zen/go/v1` |
| model | `step-5-preview-free` |
| key source | `$HOME/.dsh/.credentials.yaml` → `OPENCODE_GO_API_KEY` |
| key | `sk-dSwdM…DXMX`, length 67, written **2026-10-12 17:57 local** |
| required header | `x-opencode-session` — **omitting it gives a fast HTTP 400 `MissingSessionID`** that reads as "the endpoint is fine" |

**The key is not the problem and was never rotated out.** The same key returns `200` on
`deepseek-v4-flash` at the same moment it returns `429` on `step-5-preview-free`. A dead key
fails both. The limit is per-model.

There is no second opencode key on the machine: `OPENCODE_GO_API_KEY` is unset in the
environment, there is no `.env`, and the credential store holds exactly one opencode entry.

`/zen/v1` (the other route) answers `403 "OpenCode's free tier can only be used from within
OpenCode"` for this model. Do not switch to it.

---

## 3. What went wrong, and what was reverted

Commit `c0d460f` switched every script, config and eval yaml to `deepseek-v4-flash`, on the
conclusion that `step-5-preview-free` had been **retired**. **That conclusion was false.**

The evidence that was available and read the wrong way:

1. `/v1/models` on both routes **still lists `step-5-preview-free`** (38 and 44 models). A
   retired model is not in the catalogue.
2. The 429 body is literally
   `Upstream request failed: Rate limit exceeded. Please try again later.` — what a rate limit
   says. It was read as a retirement.
3. `ef-phase7-logs/monitor-provider.log` shows **44 consecutive 429s at 2-minute intervals,
   23:30:07 → 00:56:55 (1h27m, zero successes)**. The monitor was probing
   `step-5-preview-free` for that entire window: bash had already read the `for` loop body into
   memory, so editing the script file mid-run never changed the probe. That log is therefore a
   clean measurement of a provider-side outage.
4. The route was never the problem either. **Every log from 2026-10-06 19:40 onward records
   `/zen/go/v1`**, including all 33 comparable step-5 jobs. The base-URL half of `c0d460f` was
   cosmetic; only the model name mattered.

Reverted in `4730469` across 14 sites. The route stays `/zen/go/v1` because that is what the
step-5 era actually ran on.

**The lesson is not "429 means rate limit".** It is that a **valid but different** model produces
numbers that look like results. The guard that existed ("an unknown model fails loudly") could not
catch this, because `deepseek-v4-flash` is a perfectly valid model. Only comparability catches it,
and comparability is not something a script can check.

---

## 4. Contaminated cells — never pool these

Six cells ran on `deepseek-v4-flash`. They are stopped and registered by name in
`ef-phase7-logs/INVALID-JOBS.txt`:

```
lhtb-ef-20261013-002900-sweep-ucs-balanced
lhtb-ef-20261013-002915-sweep-ucs-quality
lhtb-ef-20261013-002920-sweep-ucs-basic
lhtb-ef-20261013-002925-sweep-ucs-economy
lhtb-ef-20261013-002931-sweep-ucs-balanced
lhtb-ef-20261013-002936-sweep-ucs-quality
```

About **592 model calls** were spent on them. They are kept on disk so the exclusion is auditable,
not because they are usable. Their reward, cost and fold behaviour are not comparable with the
step-5 corpus and must never be averaged with it.

---

## 5. The comparable corpus

Only jobs whose `result.json` eval key names `step-5-preview-free` are comparable. That key is
the authoritative model record — the per-cell transcript does **not** carry the model.

| arm | cells | with reward | mean | min | max |
|---|---|---|---|---|---|
| basic | 26 | 8 | 0.3452 | 0.0000 | 0.7795 |
| economy | 14 | 6 | 0.2640 | 0.0000 | 0.6545 |
| balanced | 11 | 5 | 0.3018 | 0.0000 | 0.7977 |
| quality | 9 | 4 | 0.4105 | 0.0000 | 0.7705 |
| **total** | **60** | **23** | | | |

**The binding constraint is that only 23 of 60 cells produced a reward.** That is the number to
move, and no amount of corpus hygiene moves it.

The apparent arm ordering (quality > basic > balanced > economy) rests on n = 4–8 per arm. **It is
noise, not a finding**, and must not be reported as one.

---

## 6. Detecting recovery

```bash
bash ef-wait-provider.sh      # waits, then relaunches a wave on recovery
bash ef-monitor-provider.sh   # waits and LOGS ONLY -- relaunches nothing
```

Use the monitor while cells are alive: the cells have their own outage ceiling and resume by
themselves, so a relaunch would double the load on an endpoint already answering 429.

One probe is not recovery. The failure mode observed here was 1h27m of unbroken 429s. Require
several consecutive 200s before relaunching.

Probe the **exact route the harness uses** — proxy, store key, and `x-opencode-session` header. A
probe missing the header gets a fast 400 and reads as "the endpoint is fine".

---

## 7. Resume procedure — LHTB

```bash
cd "D:/Data and code/xuchengjian/workplace/dsh-epistemic-fold"
git log --oneline -1                 # expect 4730469 or later
grep -n 'EF_LIVE_MODEL' scripts/run-lhtb.sh ef-ucs.sh   # MUST say step-5-preview-free
bash ef-ucs.sh                       # four arms x 2 attempts = 8 cells
```

Four arms at once is 8 concurrent cells — the largest measured point that does not make the route
queue. All four share the provider's conditions, which is the point of running them together.

Budget is 28800s and the sweep config's `override_timeout_sec` matches it exactly. A config
tighter than the task budget ends trials early.

---

## 8. Resume procedure — memory benchmark

Python is **not** on PATH; `python` resolves to the Microsoft Store stub and returns `9009`.
Use the harbor venv:

```
D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe
```

```bash
cd eval/memory
bash run-memory.sh --check-route                                # one question, error verbatim
bash run-memory.sh --calibrate --arm quality --order logical    # depth to 50% of the window
bash run-memory.sh --mode A --arm quality --order logical --depth 5
python analyse.py
```

**Verified offline on 2026-10-13:**

| check | result |
|---|---|
| `build_corpus.py` | exit 0; all six constraints pass |
| regeneration | byte-identical hashes for all five artifacts (deterministic) |
| corpus | 100 documents / 20 projects / 7,239,897 chars / **1,809,974 tokens** = 13.8x the window |
| background | 94% of it, real documentation prose, **19,346 distinct words** (the generated filler had 58) |
| probes | 204 — extraction 80, disambiguation 80, composition 20, update 4, abstention 20 |
| answer leakage | 204 keyed, 204 public, **0 leaked** |
| answer positions | 46 / 43 / 66 / 49 — position carries no signal |
| `analyse.py` | exits 1 with **"no result files found"** — correct, no cells have run |

### 8.1 Sizing — what was true, and what was decided

`EF_MEMORY_WINDOW` defaults to **131,072**, and that is the routed model's real window
(`eval/src/default-regime.ts:10`, "contextWindow 131072 (the routed model's real window)").

**The four-times rule was already met.** A "corpus is only 862k against a 1M window" blocker was
raised mid-session, and that 1M window belonged to `deepseek-v4-flash` — the model the mistake in
§3 had wrongly switched the harness to. Against the window actually under test:

```
861,697 / 131,072 = 6.57x          section 3.2.5 requires >= 4x   -> PASS
```

Section 3.2.5 already said "at least four times the window of the model under test", and line 1116
already said "at six times the window". **The design was self-consistent the whole time**, and the
blocker was an artifact of the same error rather than a property of the corpus.

**The corpus was enlarged, and then the background was replaced.** Both were deliberate, and the
second is the one that mattered. It now stands at:

```
1,809,974 / 131,072 = 13.8x         background 94%, 19,346 distinct words
```

**Why the generated background had to go.** It was 48 sentence templates over 12 topics — measured,
2,344,000 word tokens drawn from **58 distinct words**, 99.60% of a 4M-token corpus. Deleting every
filler line collapsed the corpus to 16,240 tokens, 12.4% of the window, far below the 50%-of-window
calibration target. So fold 1 already overshot the target and depth 2+ had nothing to do: **the
depth axis was dead while appearing alive.** Boilerplate creates LENGTH, not PRESSURE, and the
4M-token corpus was 3.18M tokens of a 58-word loop.

**The replacement is real technical documentation prose**, in the same register as the probed facts,
vendored as `eval/memory/filler_source.txt`. Register is the point: background in a different
register — literary prose, or source code — lets a summariser treat the facts as the only real
content and keep them, inflating retention. Source code is included only in a bounded share (8.8%).

**Only the background changed.** The 20 projects, 100 documents, 204 probes and four errata are
unchanged, and `answer_key.json`, `public_probes.json`, `orderings.json` and
`generation_report.json` are **byte-identical**. Growing the project count instead would have scaled
the probes toward a thousand and broken 3.2.10.

**Two properties are now checked rather than claimed**, because the old generator's comment asserted
its paragraphs "differ in their subject, their numbers and their phrasing" — and the phrasing was
byte-identical:

  * `tests/memory-filler-source.spec.ts` pins lexical diversity, the absence of any vocabulary field
    name, the absence of any numeric probed value, and the bounded code share
  * the disjointness rule was **narrowed and recorded**: twenty of the 86 probed values are ordinary
    English words, so "no probed value at all" is unsatisfiable for real prose. It now asserts no
    field name and no numeric value; the provenance file records which categorical values occur.

**Check this first on the first live run.** With a background that cannot be dropped for free, the
surface should no longer collapse after one fold — but confirm it: if `depth_to_target` sits at its
floor, the depth axis still has no range and the calibration is measuring nothing while looking like
it measured something. The driver reports that case rather than hiding it.

---

## 9. The hard rule

**A model name is not a configuration detail; it is the experiment's identity.**

- Never change `EF_LIVE_MODEL` to work around a provider condition.
- If a model change is ever genuinely forced, it is a **cohort boundary**: results before and after
  are two experiments and are reported separately, never pooled.
- A provider outage is waited out. It is not a reason to change what is being measured.

---

## 10. Open decisions for the human

1. **LHTB** — wait out the rate limit, or is there another quota/channel? The code is ready and
   will only ever use `step-5-preview-free`.
2. **Reward coverage** — 37 of 60 comparable cells produced no reward. This is now the largest
   obstacle to a conclusion and is independent of the provider.
3. **`ef-phase7-logs/route-msg.txt`** — a scratch note that still records the false "retired"
   conclusion. Left in place deliberately rather than quietly edited; delete or annotate on request.
