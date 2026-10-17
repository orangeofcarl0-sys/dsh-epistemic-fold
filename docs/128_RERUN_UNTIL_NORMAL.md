# 128 — Re-run until normal: three defects, and the rate-limit contamination

Status: running. 2026-10-17. Parent `16d8da4`.

## A. The instruction, and what it required

"Re-run the baseline results until all normal." 14 of 28 cells finished at `best_correct_fields =
256` -- the verifier's value for an implementation that changed nothing. **`fields > 256` is therefore
the definition of normal used here; it is not a new threshold, it is the baseline the verifier
already computes.** A cell with no reward at all also counts as not-normal, because an abandoned
trial is not a result.

## B. The rate limit contaminated four baseline cells

**This is a correction to the earlier rounds, not a detail.** The route returned `429` during part of
the sweep window, and cells that failed on it were recorded as baseline results:

```
BASELINE 20261016-22   calls= 42  pf=2  err=HTTP 429
BASELINE 20261017-0225 calls= 99  pf=4  err=HTTP 429
BASELINE 20261017-0225 calls= 12  pf=4  err=HTTP 429
BASELINE 20261017-0225 calls= 68  pf=4  err=HTTP 429
```

**So 4 of the 14 baselines must be reclassified as provider rate-limit artefacts, not model
behaviour.** The remaining 10 have `pf=0` and no provider error -- those stand as measured model
behaviour. The "run-level instability" conclusion survives for them and only for them.

## C. Three defects in the supervisor, all found by running it

**1. `wait` did not mean what it was assumed to mean.** Round 1 reported done after 180 seconds while
its cells were still running, so round 2 started against live containers from round 1 -- eight job
directories and eight containers competing for the same route and images. **The barrier is now the
ARTIFACT**: a round is over when every cell it created has a reward and `docker ps` is empty. That is
checkable and cannot report a round finished while it is still producing.

**2. The round's own timestamp did not match its job directories.** The runner generates its own
timestamp three seconds later, so the glob matched nothing, the count was 0, and the supervisor
declared **"ALL NORMAL after 1 rounds"** on a round that had produced eight baselines. **A check that
cannot fail is not a check.** Directories are now found by diffing the jobs tree before and after.

**3. It ran while the route was refusing.** Now every round begins with a live probe and waits for a
200 before spending a call -- because running against a refusing provider writes noise into the
archive, which is exactly what produced defect B above.

## D. Two shell-parsing failures worth recording

* an embedded `node -e '...'` inside `route_ok()` needed three levels of quoting, and bash parsed a
  `(` in a log message as an unterminated construct -- **the supervisor died before its first round**;
  the probe is now `scripts/probe-route.mjs`;
* a `sed` pattern containing `"` inside `"$( ... )"` was rejected the same way; counting is now
  `scripts/count-baselines.mjs`.

**And one Windows-specific trap**: `process.exit()` with a live fetch handle aborts (exit code
`0xC0000409`), so a SUCCESSFUL probe read as a failure and the supervisor would have waited forever
on a working route. It sets `process.exitCode` and returns normally.

## E. Running

```
=== round 1/12 ===
  route: 200 OK
  lhtb-ef-20261017-101227-sweep-ucs-{basic,economy,balanced,quality}
  containers=7
```

`MAX_ROUNDS=12` is a cap, not a target. **"Until all normal" cannot be promised against a process
that is genuinely random**; if the cap is reached with baselines remaining that is reported as a
failure to converge rather than hidden.
