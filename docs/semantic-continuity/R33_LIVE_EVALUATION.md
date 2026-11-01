# R33 — Live Evaluation

**Status: `not-executed` — BLOCKED.**
**Reason:** this round had no explicit budget permission for provider spend and
no resolved live route was supplied. R33 deliberately did **not** search for
ambient API keys or reuse an unapproved provider configuration.

No request was sent. No input/output token count, latency, score, or cost in
this document is a model measurement. Everything below is either an interface
check or a scripted self-test.

---

## 1. What was actually run

| Command | Result | What it proves |
|---|---|---|
| `node eval/r33/live.mjs --check` | exit 0, `interface-ok`, 17 cases | The dataset, frozen manifest, arm list, and tool protocol load without resolving credentials. |
| `node eval/r33/live.mjs --self-test` | exit 0, `executed-success`, 17/17 | The real fold host, the real tool loop, workspace writes, visible tests, and hidden checkers work end to end with a **scripted** adapter. This is plumbing, not model behavior. |
| `node eval/r33/live.mjs --run` | exit 3, `not-executed` | The live gate refuses and records the refusal. |
| `npm run eval:r33-live-check` | same as `--check` | Repeatable interface check. |

The self-test report is `eval/r33/out/self-test-report.json`; the refusal is
`eval/r33/out/live-report.json`.

## 2. Gate conditions

`--run` refuses unless **all** of these hold:

1. `R33_LIVE=1`.
2. `--manifest <path>` names an explicit JSON manifest.
3. `manifest.model` is non-empty.
4. `manifest.limits.requests`, `inputTokens`, `outputTokens`, and `wallClockMs`
   are **positive integers**. `0` is refused; it does not mean unlimited.
5. The manifest names the environment variables that hold the route
   (`route.baseUrlEnv`, `route.apiKeyEnv`), and both are set.

A missing condition writes a report with `status: not-executed` and a reason,
and exits non-zero. No key is written to any report, log, or error message.

## 3. Manifest

```json
{
  "schemaVersion": 1,
  "model": "provider/model-id",
  "route": {
    "baseUrlEnv": "EF_LIVE_BASE_URL",
    "apiKeyEnv": "EF_LIVE_API_KEY",
    "headers": {}
  },
  "limits": {
    "requests": 24,
    "inputTokens": 200000,
    "outputTokens": 20000,
    "wallClockMs": 600000
  },
  "cases": ["A1", "C1", "D1", "F1", "H1"],
  "arms": ["S", "O2"],
  "followUpSteps": 10
}
```

`cases` and `arms` are optional selections; without them the runner would use
all cases and `S,O2`. The recommended first live pilot is 4–6 cases, not all 17.

## 4. What a live run does per case

1. Mounts the real DSH runtime and `EpistemicFoldPlugin`.
2. Replays the frozen transcript into a real `Session`.
3. Runs a real compaction through the plugin (start → summary → replacement →
   end) and reconciles the journal.
4. For **S**, the Semantic Writer call is a real provider call through the
   production writer path. For **O2**, semantic continuity is off and the gold
   facts are placed in the follow-up prompt.
5. Runs the follow-up agent as a real tool loop. The model replies with one
   JSON tool object per turn; the runner executes it in an isolated workspace:
   `read_file`, `write_file`, `list_dir`, `run_tests`, `recall`, `finish`.
6. Runs the hidden checker outside the workspace.
7. Records the request count, disjoint usage counters, retries, unknown usage,
   wall clock, tool calls, recall attempts/success, checker results, and the
   model's messages in the row trace.

The fold is not simulated and the code is not pre-written. A case with no fold
is invalid.

## 5. Budget and usage

One `BudgetLedger` is created for the whole run and shared by:

* the fold's Semantic Writer call;
* every follow-up turn;
* every retry.

`MeteredAdapter` wraps the provider adapter, so a request cannot bypass the
ledger. A reservation is taken before the call; unknown usage keeps the
reservation charged. The counters are:

```text
requests
inputTokens          uncached input only
outputTokens
cacheReadTokens
cacheWriteTokens
retries
unknownUsage
wallClock (ledger start to report)
```

No monetary figure is computed unless a verified price table is used; none was.

## 6. Run status and exit codes

| Status | Meaning | Exit |
|---|---|---:|
| `executed-success` | Completed, every case valid, at least one task success. | 0 |
| `executed-partial` | Completed with some invalid/unsucceeded cases. | 2 |
| `not-executed` | Gate refused; nothing spent. | 3 |
| `budget-exhausted` | The global ledger stopped the run. | 4 |
| `provider-unavailable` | Route missing or provider failed before a measurement. | 5 |
| `invalid-benchmark` | Dataset/schema/checker failure. | 6 |
| `executed-failed` | Ran, but no usable task result. | 7 |

A run that produces four errors and exits 0 would be indistinguishable from a
success; this mapping exists so that cannot happen.

## 7. What the live runner does not yet do

* It runs **S and O2 only** in the first pass. O1/OR/F/N are offline arms; adding
  them live is straightforward but would multiply spend.
* `recall` searches the frozen transcript. It is a controlled stand-in for exact
  recall, not the production `context_recall` tool. The trigger behavior it
  measures is “does the agent ask when the answer is missing”; the production
  tool's exact bytes are covered by the R31/R32 recall tests.
* The follow-up protocol is a text JSON tool object, not native function
  calling. This keeps the runner provider-agnostic; it is documented and visible
  in the trace.
* Natural-pressure folding is not implemented; folds use the frozen boundary.
* Multi-fold / root / exit / fork behavioral runs are not implemented.

## 8. Why blocked is the honest result

The brief's rules are explicit: real model runs require `R33_LIVE=1`, a resolved
route, positive token limits, and an explicit manifest; no key may be searched
for or logged; and no result may be fabricated. None of those inputs was
supplied in this round, so the correct output is `not executed`, not a plausible
zero.

To run the pilot once a budget is approved:

```bash
R33_LIVE=1 \
EF_LIVE_BASE_URL=... EF_LIVE_API_KEY=... \
node eval/r33/live.mjs --run --manifest live-manifest.json
```

The runner writes `eval/r33/out/live-report.json` and exits with the table
above. If the provider fails before any measurement, the status is
`provider-unavailable`; if the budget stops it, `budget-exhausted`. Neither is a
task result.
