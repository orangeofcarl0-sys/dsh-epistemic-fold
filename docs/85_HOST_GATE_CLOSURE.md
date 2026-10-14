# 85 — Host gate closure: two corrections and two defects

Status: **P1 HOST GATES BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `9b53746`.

## A. Correction: the Economy fold is SUPPOSED to make no auxiliary call

`docs/84` blamed a fixture for a fold that committed with zero provider requests, calling it a
fallback path. **That was wrong.** The source says otherwise:

* `src/preset.ts:219` economy -> `semanticMode: 'none'`; `:243` balanced -> `'none'`; `:282` quality -> `'rationale'`.
* `src/engine.ts:1733` branches on `'rationale'` to call `rationaleOnly`.
* `src/engine.ts:1758`, in the other branch: **`semanticMode 'none': no LLM call at all -- zero-LLM profile`**.

So the zero-HTTP fold is case **A: the documented zero-LLM profile**, not a fallback and not a
defect. **`ECONOMY ZERO-AUXILIARY PATH VERIFIED`.** Gate A is not a P1 blocker: the P1 arm is
Economy, and Economy has no auxiliary call to share a budget with. The cross-mode budget regression
needs a QUALITY fixture, and it is recorded as OPEN rather than promoted into the P1 gate -- exactly
as the brief directs.

## B. A defect that would have killed the run at request #1

`DEFAULT_OUTPUT_RESERVE` was **131,072,768** -- not 131,072. An earlier regex replacement matched
`\d+` against `32_768`, stopped at the underscore, and appended the new figure in front of the old
remainder. The reserve was therefore **1000x the 100,000 output limit**, so the very first admitted
request would have exhausted the output budget and the episode would have been refused before doing
any work.

Nothing about the code looked wrong: it type-checked, the 13 admission tests passed (they construct
their own reserves), and the value was only ever compared against a limit it dwarfed. **The
provenance test caught it by asserting the reserve against its own stated derivation.**

Now `131_072`, asserted in the snapshot.

## C. A second defect: settlement was not concurrency-safe

`outstanding` held ONE reserve. With two requests in flight the second admission overwrote the
first's entry, so the first response settled the SECOND request's reserve and the first was
stranded: `reservedPromptTokens` ended at 131,072 after both had answered.

Settlement is now a FIFO of unsettled reserves. Order does not matter for the aggregate that
admission compares: one `record` settles exactly one admission, so `reserved` always equals
(admitted - recorded) x reserve and out-of-order responses cannot release more than was reserved.

**This matters because the cost bound allows exactly one overshoot**, which is only sound if a
request cannot reach the provider before its own reservation is charged. That is now measured, not
assumed: both requests reserve before either fetch is answered, one settlement frees only its own
reserve, and the other's is untouched.

## D. Provenance: PREPARED, and explicitly not a live record

```
PREPARED / NOT A LIVE RUN
efSha            9b537466a2177a43c6785527f6fce00dd78d2e34
lhtbSha          ccefd696a30f2b117c757922a1f5f85000aabe28
dshSession       0.2.0-rc.2
dirtyFiles       196      dirtyDiffHash caf0b6d9508e6776a75d42131536cfc5
probeYamlHash    b060761c37c5650dc0d84d42f86162cd
model            deepseek-v4.1-flash
route            https://opencode.ai/zen/go/v1     headerNames [x-opencode-session]
engine           economy       taskRootMode exact
contextWindow    131072        threshold 65536
budget           requests 140, prompt 7,000,000, output 100,000, wall 5,400,000
reserves         input 131072, output 131072
```

No credential, header value or task text is captured -- names only, asserted by a negative match on
the serialized snapshot. The launch gate is exercised rather than asserted from source text: a
missing variable, an empty one, a non-numeric one, a negative one and a ZERO all refuse to prepare.

**This is a dry run.** The Live run must recompute every field, because the commit, the dirty set
and the effective YAML can all move. Presenting this as run provenance would be a fabricated record.

## E. Gates still open

| gate | status |
|---|---|
| Economy zero-auxiliary policy | **PASS** |
| Budget accounting | **PASS** (14 admission + 2 provenance) |
| Concurrent reservation | **PASS** (FIFO, measured with two in flight) |
| Provenance freeze readiness | **PASS** (PREPARED) |
| Quality rationale budget regression | **OPEN** |
| Python budget termination | **BLOCKED** |
| Task Root fail-closed | **BLOCKED** |
| Watchdog termination | **BLOCKED** |
| Regression | **PASS** |

Three host gates remain, none of which needs a provider request.
