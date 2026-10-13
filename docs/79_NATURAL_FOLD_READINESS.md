# 79 — Natural-fold readiness gate

Status: IPC case B reproduced and fixed; fold opportunity estimated from real archives. 2026-10-14.
Parent `f0128ef`.

## A. IPC liveness gate — case B was REAL, and is now fixed

`docs/78`'s `closeIgnored` monkeypatched `_send` to a no-op. That proves only case A -- that
`close()` proceeds when `_send` returns or raises. It cannot show what happens when `_send` actually
**waits** on a live child, because in it the wait never happens.

Case B is: the child is **alive, keeps stdout open, and answers nothing**. `_send` read with
`self._read_timeout_sec` -- default **1200 s** -- and `close()` called `_send` **before**
`terminate()`. So a wedged or merely busy host made shutdown block for twenty minutes while the
child sat there holding its session.

**Reproduced** with a real child (`tests/fixtures/silent-bridge-child.py`: reads stdin, writes
nothing, stays up) and the production timeout left in force. Under a 60 s watchdog the driver died
`ETIMEDOUT` -- the reproduction, not an inconclusive hang.

**Fix**: `_send` takes an optional `timeout`, and `close()` passes `_close_timeout_sec`
(`EF_BRIDGE_CLOSE_TIMEOUT_SEC`, default **5 s**). The graceful `op:"close"` is unchanged; it simply
gets a courtesy's deadline instead of an episode's, and `terminate`/`kill` still does the rest.
Failure still cannot mask a result, and only this process's own child is touched.

| | before | after |
|---|---|---|
| `close()` against a silent live child | **> 60 s** (would wait 1200 s) | **< 15 s**, measured ~5 s |
| child reaped | (not reached) | yes |

Case C -- an asyncio cancellation delivered while a SYNCHRONOUS `_bridge.step()` is on the stack --
is **not** addressed: the client speaks over blocking pipes and `run()` cannot return to its event
loop until `step()` returns. Covering it means rewriting the bridge IPC as async, which is out of
scope for this round and is recorded as a limitation, not a task.

## B. Historical workload audit

Every LHTB run with an `ef-transcript.json` was read offline. Eleven exist; the `unknown-config-semantics`
ones are below (58 job directories exist, most without a transcript).

| job | arm | calls | folds | last tokens | pruner | provenance |
|---|---|---|---|---|---|---|
| 20261013-111822 probe | economy | 366 | **1** | 22,322 | mounted | **DIAGNOSTIC ONLY** (pre-wiring) |
| 20261013-182012 sweep-ucs | basic | 112 | 0 | 63,941 | mounted | DIAGNOSTIC ONLY |
| 20261013-182012 sweep-ucs | basic | 96 | 0 | 32,066 | mounted | DIAGNOSTIC ONLY |
| 20261013-182102 sweep-ucs | economy | 114 | **1** | 61,203 | mounted | **DIAGNOSTIC ONLY** |
| 20261013-182102 sweep-ucs | economy | 62 | 0 | 58,486 | mounted | DIAGNOSTIC ONLY |
| 20261013-182106 sweep-ucs | balanced | 112 | **1** | 58,832 | mounted | DIAGNOSTIC ONLY |
| 20261013-182106 sweep-ucs | balanced | 94 | 0 | 56,153 | mounted | DIAGNOSTIC ONLY |
| 20261013-182111 sweep-ucs | quality | 30 / 23 / 30 | 0 / 0 / 0 | 31,775 / 28,813 / 25,670 | mounted | DIAGNOSTIC ONLY |
| 20261014-021547 probe | economy | 16 | 0 | 23,909 | mounted | operator-censored |

**Every 2026-10-13 run is `DIAGNOSTIC ONLY`.** They carry no `task_root` field at all: they predate
the host wiring, so they cannot speak to pinning. They are legitimate evidence about *workload and
pressure shape* -- same task, same 131072 window, same 65536 threshold, Economy preset, pruner
mounted, `compactionFailures=0` -- and no more than that.

None of them is `COMPARABLE` to a pilot: the DSH runtime, the wiring and the session lifecycle have
all moved since. `CENSORED`: 20261014-021547 (operator). Provable: none had `taskRoot`, so none is
`COMPARABLE` for the mechanism question.

## C. Fold opportunity, bounded

The two Economy runs that actually folded, and what they cost to get there:

```
yFUiH4d  114 model calls  fold leaf tokensBefore 65,974  shadowed 108 seqs / 42,351 tokens
fCqYKTb  366 model calls  fold leaf tokensBefore 65,565  shadowed 145 seqs
```

* **First-fold pressure: ~65,600-66,000 tokens** -- the 65,536 threshold, plus the message in flight.
  Both runs agree within 0.6%, and both were measured with the pruner mounted.
* **Cost to the first fold: at most 114 model calls**, cumulative prompt **5.33M tokens**
  (`tokensTotal` for the 114-call run). The exact call index is NOT recoverable: the transcript
  records the fold's `tokensBefore`, not the call counter at which it fired.
* The operator-censored run stopped at **16 calls / 23,909 tokens = 36 % of the required pressure**,
  which is consistent with the same climb and can tell us nothing more precise. It is a
  **right-censored observation**; no slope from 16 points is extrapolated into a first-fold time.

**Token-per-call: `UNKNOWN` as a single number.** It is not the average (5.33M cumulative is mostly
cache re-reads of a prompt that grows and then resets at each fold) and the runs that ended
unfolded (58,486 at 62 calls, 61,203 at 114) show it is not monotonic either. The defensible
statement is the pair above: threshold at ~65.6K, reached within 114 calls.

## D. Pre-registered pilot

**Variable: `EF_LHTB_TASK_ROOT_MODE = exact` vs `off`.** Nothing else moves -- Economy preset, the
same model and route, window 131072, threshold 65536, retention, pruner, task revision, host, DSH
runtime, agent prompt and tool protocol, time and cost limits. **Basic is deliberately excluded**;
it answers a different question and is not needed to size the mechanism's benefit.

**Task: `unknown-config-semantics`.** It is the only task with real fold evidence under exactly this
window and threshold, it has an official verifier, and both Economy runs that folded did so on it.
Backup: `vector-db-iterative-build` -- **limited**: no transcript in the archive shows it folding,
so it is not a substitute on fold-opportunity grounds.

**Order and n, fixed in advance:** `exact`, then `off`, then `exact`, then `off` (n=2 each),
**sequentially**. Not interleaved and not in parallel, so provider drift over the session is a real
confound and is recorded as one rather than averaged away. If only one pair is affordable, it is
reported as a **pilot with n=1 and no quality claim**.

**Stop rules, agreed before starting:**

| rule | value |
|---|---|
| max model calls per episode | **140** (~25 % over the observed 114) |
| max wall clock per episode | **90 min** |
| max provider failures | 3 consecutive, or 10 total |
| observations after the first fold | **at least 8 effective work turns** |
| task ends with no fold | `NATURAL FOLD NOT EXERCISED` |
| budget reached, no fold | `CENSORED -- NO NATURAL FOLD` |
| provider or Docker failure | infrastructure-censored; the other arm still runs |
| `taskRoot` becomes `absent` | **abort immediately**, preserve the transcript |

The task's own 4-hour agent ceiling is NOT the authorization: the 140-call cap binds first and is
the one that costs money.

**Cost, from the archive rather than guessed:** to the first fold, ~110-114 calls and ~5.3M prompt
tokens, of which the 114-call run read **2.2M from cache** (`tokensCacheRead`), so the billed input
is far below the raw figure. Four episodes at that ceiling is the worst case; the pilot stops at the
first pair if the fold does not appear. **No dollar estimate is quoted**: `costTotal` uses a proxy
price profile, so any figure would be an estimate presented as a bill.

**Success conditions, kept apart (§8):** fold opportunity; task residency after the fold;
operational recall *if the model chooses it* (a model that does not need retrieval is not a failure);
post-fold work (real tool calls, files written, stage goals met); official reward; and the paired
pinned-vs-unpinned difference. **n=1 is pilot behaviour only** and is never reported as a quality
gain or a tier ranking.

## E. What this round changed

`eval/bridge/ef_bridge_client.py` (the close timeout), plus
`tests/fixtures/python-bridge-close-hang.py`, `tests/fixtures/silent-bridge-child.py` and
`tests/python-bridge-close-hang.spec.ts`. No provider request was made; no threshold, fold, recall,
preset or Basic change; the dirty benchmark files were left alone.
