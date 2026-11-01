# R34 — Evaluator Audit (R33.1 closure)

Status: **closed for offline execution; live remains `not-executed / blocked`.**

This document records every evaluator defect confirmed in R33, the reproduction
that failed before the fix, and the regression that now passes. It is an audit of
the INSTRUMENT, not a product claim. The R33 published numbers are preserved
unchanged under `eval/r33/frozen/v1/`.

Environment: Windows 10.0.26200, Node v24.14.1, npm 11.11.0, Vitest 5.0.5,
installed DSH `0.2.1-rc.3`, vendored DSH `0.1.7-rc.2`.

---

## A. Budget and result accounting

### A1 — the global budget was charged per `stream()`, not per HTTP attempt

**Before.** `MeteredAdapter.stream()` reserved once and recorded once. The
OpenAI-compatible adapter retries HTTP 429 internally, so one `stream()` could
be two, three, or four real HTTP requests. The ledger counted one. A run could
therefore exceed an authorized request count without violating the ledger.

**Fix.** `BudgetLedger` now implements the adapter's own pre-request interface
(`admit`, `retry`, `record`, `release`) and is passed as the adapter's `budget`.
`admit` runs immediately before `fetch`, including for each 429 resend. Each
attempt is admitted and counted; a 429 keeps its reserve and is counted as
unknown usage, so throttling cannot make requests look free. The scripted
self-test still uses `reserve`/`recordStream`, explicitly named as the non-HTTP
path.

**Regression.** `tests/r331-budget-http.spec.ts` starts a local mock provider
that answers `429, 429, 200`:

```text
HTTP attempts observed by server     3
ledger attempts                      3
observed input/output tokens         12 / 4
unknown 429 attempts                 2  (reserves retained)
adapter retries                      2
```

With a global request limit of 2, the server receives **exactly 2** requests;
the third is refused before `fetch` and the adapter yields a
`BUDGET_EXHAUSTED` finish. `tests/live-budget-admission.spec.ts` also passes its
existing attempt-level cases.

### A2 — snapshots aliased the live counters

**Before.** `snapshot()` returned `{ used: this.used }`. `runOne()` subtracted
two snapshots that were the same object, so per-case cost was meaningless.

**Fix.** `snapshot()` returns a frozen deep copy of `limits`, `used`, `observed`,
`reserved`, `charged`, and `remaining`.

**Regression.** `tests/r33-live-entry.spec.ts` takes snapshot A, records one
request, takes snapshot B, and asserts A is unchanged while
`B.requests - A.requests = 1` and the token delta equals the recorded usage.
`tests/r331-budget-http.spec.ts` repeats it around a real mock HTTP call.

### A3 — the run status read a field that did not exist

**Before.** `runStatus()` read `entry.taskSuccess`, while `runOne()` returned
`{ behaviour: { taskSuccess } }`. Every valid row looked like a failure.

**Fix.** The live result contract is one shape:
`{ valid, behaviour: { taskSuccess }, ... }`. `runStatus()` reads
`behaviour.taskSuccess`. `runQuality()` separately reports
`measurementValid`, `validCases`, `invalidCases`, `taskSuccesses`, and
`taskSuccessRate`.

A run where every measurement is valid and every task failed is
`executed-failed` **with `measurementValid: true`**. That is a negative research
result, not a broken harness.

**Regression.** `tests/r33-live-entry.spec.ts` checks all seven statuses and the
valid-but-zero-success distinction.

### A4 — partial and unknown usage were silently zero

**Before.** `usage.inputTokens ?? 0` treated an unreported dimension as free.
`record()` settled the whole reservation even when the provider reported only
prompt tokens.

**Fix.** Usage is kept in four separate buckets: observed input/output/cache
read/cache write, reserved input/output, unknown requests, and partial requests.
Settlement is **per dimension**: a dimension the provider did not report keeps
its reserve. An absent usage record keeps the whole reserve and increments
`unknownUsageRequests`.

**Regression.** `tests/r331-budget-http.spec.ts`:
- `usage = { prompt_tokens: 10 }` → observed input 10, output reserve retained,
  `partialUsageRequests = 1`;
- no `usage` at all → `unknownUsageRequests = 1`, full reserve retained.

### A5 — per-case wall clock was the global run clock

**Before.** every row recorded `ledger.elapsedMs()`, the run's cumulative time.

**Fix.** rows carry `cost.caseDurationMs` (measured around one case/arm) and
`cost.runElapsedMs` (the global clock). `aggregateArm` sums only
`caseDurationMs` and reports `caseMsPerSuccessfulTask`.

### A6 — cost boundary

No trusted price profile was supplied, so **no currency is reported**. The
reports distinguish:

- observed tokens (provider-reported);
- reserved tokens (conservative, for unknown or partial requests);
- charged tokens (observed + reserved);
- HTTP attempts and retries;
- per-case duration and per-success token/attempt figures.

`costNote` in every aggregate says the harness must not invent dollars. The live
manifest refuses a missing per-request output bound (`maxOutputTokens`).

---

## B. Isolation, secrets, and checker authority

### B1 — the provider key was inherited by the code under test

**Before.** `runNode()` used `env: { ...process.env, ...extra }`. A generated
test process could read the provider API key.

**Fix.** Children receive an explicit allowlist: `PATH`, `PATHEXT`,
`SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `TEMP`, `TMP`, `TZ`, `LANG`,
`LC_ALL`, plus harness-owned `R33_*` names. `NODE_OPTIONS` is deliberately
excluded (it can inject code). Any extra whose name looks like a credential is
refused even if the harness asks for it.

**Regression.** `tests/r331-isolation.spec.ts` sets
`TEST_PRIVATE_API_KEY=secret-sentinel` in the parent and runs a child that prints
its own environment. The child prints `null`. A direct attempt to forward
`MY_TEST_API_KEY` throws `credential-shaped`.

### B2 — workspaces were reused between runs

**Before.** `materialize()` only overwrote known files. A helper or
`verification.json` from the previous run survived into the next replicate.

**Fix.** Every replicate gets
`runId/caseId/arm/replicateId/{workspace,session,bundles,journal,trace}`.
`createReplicateLayout` creates the base with `mkdir(recursive: false)` and
fails if it exists. The workspace is never reused, and old runs are never
cleaned.

**Regression.** `tests/r331-isolation.spec.ts`: run 1 creates an extra file; a
second layout with the same key throws `EEXIST`; a run with a new `runId` does
not contain the extra file. `tests/r331-live-writer.spec.ts` confirms each arm
gets its own workspace, bundles, and journal.

### B3 — the checker trusted any `R33_RESULT` line on stdout

**Before.** `runChecker()` took the first stdout line beginning with
`R33_RESULT`. A workspace module could print one during import and pass itself.

**Fix.** The checker runs inside a trusted bootstrap written outside the
workspace. The bootstrap captures stdout during import, selects only the LAST
marker line, and writes the parsed payload to a private result file that the
harness reads instead of stdout. The payload is validated against the case's
declared `checker.expectedChecks`:

- missing, duplicate, or unknown checks → `checker-invalid`;
- a failed check → `executed` + task failure;
- a checker crash → `checker-crashed`;
- a deadline → `checker-timeout`;
- non-zero exit with every check passing → `checker-invalid`.

**Regression.** `tests/r331-isolation.spec.ts` has a module that prints
`R33_RESULT {"checks":[{"name":"fake","pass":true}]}` during import and a checker
that prints a real failing check. The harness reports the REAL failing check and
`spoofMarkers: 1`. Missing/duplicate/unknown names, a timeout, and exit-code
inconsistency are separate statuses.

**Limit.** Same-user code can still attack the checker process or read files
elsewhere; `ISOLATION_LEVEL.osSandbox = 'none'` says so. This is not an
adversarial sandbox.

### B4 — agent workspaces sat next to gold and checkers

**Fix.** Live run roots default to `~/.r33-runs` (or `R33_RUN_ROOT`), outside the
repository. Checkers run from the OS temp directory, never inside the
workspace. Agent tools are path-checked: `resolveInside` rejects POSIX-absolute,
Windows-drive, UNC, NUL, and `..` forms, then checks the real path of the target
or its nearest existing ancestor. Junctions/symlinks that escape are refused.

**Regression.** `tests/r331-isolation.spec.ts` covers `..`, `/etc/passwd`,
`C:/Windows/win.ini`, UNC, and a directory junction to an outside directory.
`readWorkspaceFile`/`writeWorkspaceFile` refuse the junction path.

### B5 — timeout and output diagnosis

**Before.** the kill timer set no state; a timed-out child was reported as a
normal non-zero exit. Output was unbounded.

**Fix.** `runNode` returns mutually exclusive `timedOut`, `processError`, and
normal exit state, plus `stdoutTruncated`/`stderrTruncated` and `durationMs`.
Capture is capped (256 KiB by default).

**Regression.** `tests/r331-isolation.spec.ts`: a 200 KB stdout with a 1 KiB cap
returns exactly 1 KiB and `stdoutTruncated: true`; a checker that hangs returns
`checker-timeout` with `timedOut: true`.

---

## C. Gold, grounding, and pairwise scoring

### C1 — a same-coordinate counter-claim scored as correct

**Before.** `extractionMetrics` fell back to "any unused gold fact at the same
coordinate" when the exact statement did not match. So gold "must preserve the
legacy API" matched delta "must remove the legacy API".

**Fix.** Three separate observations:

- `coordinateRecall`: a proposal exists at the right subject (weak);
- `claimCorrectness`: the statement matches the frozen gold statement;
- `sourceSupport`: at least one of the proposal's own evidence quotes occurs in
  the gold fact's authoritative source messages.

A same-coordinate different statement is `requires-review`, never correct. A
correct statement with the wrong verification state is also `requires-review`
(status-mismatch). The expected state is derived from citation authority: a fact
grounded in a tool result is `observed`, otherwise `claimed`.

**Regression.** `tests/r331-scoring.spec.ts` covers opposite claim, wrong
verification state, wrong scope, correct statement with the wrong source
authority, and a visible superseded fact. The R33 coordinate fallback would have
scored the first and third as correct.

### C2 — gold quotes were not bound to their cited messages

**Before.** a quote only had to occur somewhere in the transcript. Three v1
facts cited a corroborating message that did not contain the quote.

**Fix.** v2 requires the quote to occur in EVERY authoritative `sourceRef`;
new optional `corroboratingRefs` carry context that does not contain the quote.
The three affected facts were corrected:

```text
B2-memory            sourceRefs [0], corroboratingRefs [2]
C1-fs-watch-rejected sourceRefs [2], corroboratingRefs [1]
D1-not-run           sourceRefs [2], corroboratingRefs [3]
```

No quote, statement, transcript, task, action, or hidden assertion was changed.
The runner records a transcript-index → DSH event-seq mapping
(`sourceBindings[].refs[].eventSeq`); the report never treats an array index as
an event seq.

### C3 — rescue and damage were reversed

**Before.** `pairwise(rows, 'S', 'B1')` returned `rescue = rightOnly` and
`damage = leftOnly`, which reads backwards for the treatment (S) on the left.

**Fix.** `compareTreatment({ baselineArm, treatmentArm })` defines:

```text
rescue = treatment succeeds AND baseline fails
damage = treatment fails   AND baseline succeeds
```

The old `pairwise` API was removed, not merely documented around.

**Regression.** `tests/r331-scoring.spec.ts` asserts a treatment-only success is
`rescue`, a baseline-only success is `damage`, and repeated rows of one case are
not independent cases.

### C4 — false memory was reported as one undifferentiated test

**Fix.** The report separates:

```text
FM-1  wrong-context ACTION sensitivity        scripted, 8/8 detected
FM-2  false claim admitted by Writer/Validator deterministic, refused
FM-3  real agent resists conflicting memory    not executed (needs live)
```

`tests/r331-scoring.spec.ts` drives a normative claim citing a tool result and a
claim citing a fabricated quote through the REAL validator. Both are refused
(`authority-ungrounded`, `evidence-not-found`); `packet.accepted` and
`packet.ops` stay empty. This is not an "EF resistance rate".

### C5 — dataset and scorer versioning

- Dataset v1 is preserved in Git at `ad3020df0e22587f78490c19550fe6986f55af3f`
  and under `eval/r33/frozen/v1/` (manifest + reports).
- The current development set is `r33-semantic-continuity-v2`, digest
  `407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f`,
  scorer v2.
- A separate holdout, `r33-semantic-continuity-holdout-v1`, digest
  `af22eb7a91155507998750f0428be8bb7c6285696179128a75e83f3eeaada663`,
  is frozen and not executed.
- `eval/r33/out/scorer-comparison.json` records old vs new arm metrics. On the
  frozen v2 cases **no case/arm number changed**: the writer proposals in this
  dataset were already exact and source-supported. The scorer difference is
  demonstrated by the deterministic counter-examples above, not by rewriting
  old results.

---

## D. Recovery evidence and live diagnostics

### D1 — a missing receipt with no state witness was repaired on trust

R33 bound a missing-receipt repair to `bundle.state.digest`. If the bundle was
also missing or corrupt, no expectation existed and the packet's own `ops` were
promoted.

**Fix.** `validateJournal` now demotes a missing-receipt packet with no readable
`bundle.state.digest` to `conflict` / `missing-state-witness` and blocks the
journal. Legitimate recovery still works when the witness exists. Old-format
bundles without a state digest are refused and documented as such.

**Regression.** `tests/r33-receipt-window.spec.ts`:
- untampered missing receipt + bundle witness → repaired;
- replaced legal ops + witness → `ops-state-mismatch`;
- missing bundle → no receipt, health not ready;
- corrupt bundle → no receipt, health not ready.

`tests/semantic-recovery.spec.ts` was updated to build a CURRENT bundle with a
state digest for the legitimate recovery, and adds a legacy no-state case that
fails closed. This preserves the R31 contract for real current data while
closing the unverified path.

### D2 — live writer diagnostics were `undefined`

**Fix.** Every live/self-test row now records, from the real engine and journal:

```text
writer.call / protocol / integrity / coverage
raw writer output (bounded), oracle flag and basis
proposed / accepted / refused / limitExceeded / refusal reasons
committed state (anchors, commit count, state digest)
visible checkpoint (digest, chars, text)
source bindings with DSH event seqs
```

`--self-test` proves the path without a provider: S made 17 writer calls and
accepted 30 deltas; O1 accepted 33 through the same validator/journal/working
set; B1 and O2 made no writer call and committed no state. The raw records are
under each replicate's `trace/record.json`; the summary keeps a bounded copy.

---

## Gate status

| Gate | Status | Evidence |
|---|---|---|
| A — Live safety | **PASS** | mock 429/429/200 attempt accounting; immutable snapshots; partial/unknown reserves; env sentinel; fresh workspaces; no credentials in reports |
| B — Evaluator correctness | **PASS** | checker spoof rejection; source-bound gold; counter-claim not correct; rescue/damage direction; status contract; timeout/crash/task distinction |
| C — Comparable arms | **PASS (executable, provider blocked)** | B1/S/O1/O2 self-test 68/68 through the real fold host; O1 traverses the real semantic runtime; shared initial state and separate stores |
| D — Real behavioural evidence | **BLOCKED** | no explicit live authorization/budget; 0 provider requests |
| E — Reproducibility | **PASS for offline** | Git SHA, dataset/holdout digests, scorer version, run id, replicate id, traces; live raw usage is `not-executed` |
| F — No product expansion | **PASS** | no new journal schema, MemoryOS, vector store, second compaction engine, or prefetcher; one recovery guard only |

## Test result

Full suite, vendored dependency graph, bounded worker pool:

```text
Test files  142 passed | 4 failed | 24 skipped (170)
Tests       1421 passed | 4 failed | 66 skipped (1491)
Duration    119.67s
```

Three failures are the known installed-vs-vendored DSH drift assertions
(`bridge-loads`, `rc3-plugin-packaging`, `rc7-inplace-drift`), unchanged from
R33 and unrelated to the evaluator work. They fail because this machine has DSH
`0.2.1-rc.3` installed while the vendored test graph is `0.1.7-rc.2`.

The fourth is a load-sensitive host-suite test, not an assertion about this
work. It changes identity between runs (`lhtb-runner-dispatch` on one run,
`task-root-bridge` on the next) and passes when its file is run alone. R33
recorded the same class of timeout under full-suite load. The R33/R33.1 suites
themselves all pass in the full run; the bounded worker pool is in
`vitest.config.ts`.
