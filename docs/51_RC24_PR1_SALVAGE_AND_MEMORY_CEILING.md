# RC24 — PR #1 salvaged, and a memory ceiling that was wrong twice

PR #1 (`lhtb-longwork-findings`) was open, reported `MERGEABLE`, and applied
cleanly — 897 tests passing on a trial merge. It was **not** merged as a unit,
because real fixes and a falsified headline were mixed in one branch. This round
took the fixes, left the conclusions, and corrected a measurement that both the
PR and a spec built on it had wrong.

## 1. Why a clean merge was the wrong action

`MERGEABLE` is a statement about text. The PR's two headline claims were both
produced by harness paths that RC23 had already fixed:

| claim (PR) | why it cannot stand |
|---|---|
| "`roots` is 0 in 16 of 16, so the rebase path never ran anywhere" | the `roots` detector was `text.includes('"kind":"root"')` on a `CompactionResult` that has no `kind` field — it could never fire |
| "EF reached the reference solution on both discriminators" | measured on a `basic` arm that was EF-legacy, and on arms whose roots counter was dead |

Merging would have published those conclusions into `main`'s docs alongside their
refutations. RC23 already records what the same lane showed once the harness was
correct, so `docs/48_LHTB_LONGWORK_FINDINGS.md` was **not** brought forward.

A second, quieter reason: PR #1 adds `48_LHTB_LONGWORK_FINDINGS.md` while `main`
has `48_RC22_…`. Both are `48_`. A textual merge produces **two** documents with
the same number, and the new one is not in the index.

## 2. What was salvaged — each verified on `main` first

### 2.1 The tau2 lane was dead on `main`

`eval/tau2/ef_tau2_adapter.py` called `self.bridge.turn(message)`. Enumerating the
class's methods by AST gives `__init__, _stderr_tail, _send, init, turn_raw,
append, step, call_tool, close` — **there is no `turn`**. A tau2 run from a clean
checkout died on the first turn with `AttributeError`. Repaired with `turn_raw`
plus the existing `_to_wire`/`_from_wire` pair.

### 2.2 `premature-stop` equalled the failure count

`TerminationReason` is a `str` enum with no `__str__` override, so
`str(TerminationReason.USER_STOP)` is `'TerminationReason.USER_STOP'`. The
taxonomy compared that against `("agent_stop", "user_stop")` — never true.
Reproduced directly: the old test is `True` for every cell, so the column was a
constant multiple of the failure count, which looks like information and carries
none. `_termination_kind` normalises at both the store site and the compare site,
so an archive written before the fix still classifies correctly.

### 2.3 `--out` was accepted and never passed

`run_tau2.py` has always had `add_argument("--out")`; `run-tau2.sh` never passed
it. A sweep therefore left no machine-readable record — one 96-cell sweep had to
be recovered from console text. The wrapper now stamps a UTC filename and honours
`EF_TAU2_OUT`.

### 2.4 Run archives carried no provenance

Added `ef-tau2-run/1` beside the cells: preset, arms, replicates, concurrency,
seed, route, and each checkout as `{locator, rev, dirty}`. **No filesystem path**
— a tracked archive naming one machine's layout fails the release gate, and the
revision is the actual anchor.

### 2.5 `NO_PROXY` scrubbed once, for every runner

`scripts/proxy-env.sh` handles a *different* defect from the `HTTPS_PROXY` one
RC23 fixed: httpx reads a bracketed IPv6 literal in `NO_PROXY` as `host:port` and
fails with `Invalid port: ':1]'` before any request is sent. The two are
orthogonal and now coexist: the proxy is opt-in, and `NO_PROXY` is scrubbed
unconditionally.

## 3. The memory ceiling was wrong — in the PR and in the spec

The PR's `lhtb-parallelism.spec.ts` asserted `WSL_CAP_GB = 24` and stated the
WSL VM is capped at 24 GB. Verified three ways on this host:

| source | value |
|---|---|
| `~/.wslconfig` | `memory=8GB` |
| that file's own comment | records a deliberate 2026-09-24 reduction **from 12 GB to 8 GB** on a 15.2 GB host |
| `docker info` `MemTotal` | 8,326,361,088 bytes = **7.75 GiB** |

The error was load-bearing. The spec's arithmetic was
`declaredTwoGiB (12) <= WSL_CAP_GB`; at 24 this **passed**, and at the true 8 it
**fails**. A cap that was too large was the only reason a wrong assertion stayed
green — the same shape as the `roots` detector, where a number that could not mean
what it claimed was read as if it did.

The assertion was also wrong in kind: it summed the tasks' DECLARED `memory_mb`
values and compared them to the cap, but a `memory_mb` is a cgroup **limit**, not
a reservation — which is the very point the file exists to make. It now compares
the MEASURED figures (193 MiB and 16 MiB) against the cap.

The corrected claim is still true and worth having: two cells fit with room for
the build and verifier phases, so the lane can run in parallel. The probe config
stays at `n_concurrent_trials: 1` **by choice**, and now says so instead of
calling it a hardware limit.

## 4. The 180-minute cap

PR #1's `lhtb-ef-sweep.yaml` set `override_timeout_sec: 10800` (180 min) with the
comment "the task's own agent budget is the real limit; this bounds a runaway
loop". The task declares `timeout_sec = 14400` (**240 min**), so 10800 is not a
bound above the budget — it is 25% *below* it. Measured consequence in the Phase 6
probe: **every timeout row sat at 180/181 minutes**, so that cap, not the task,
ended those trials. Both the sweep and the probe now use 14400.

## 5. Verification

- **897 passed, 23 skipped, 0 failed**; three typecheck projects clean.
- Every salvaged fix verified at runtime, not by reading: the method list by AST,
  the enum rendering reproduced directly, the provenance block printed and scanned
  for machine paths (none), the memory figures from three independent sources.
- `tests/lhtb-parallelism.spec.ts` and `tests/tau2-bridge-contract.spec.ts` both
  brought forward; 10 assertions, all passing.

## 6. Disposition

PR #1 is superseded by this round: its fixes are here, corrected where they were
wrong, and its conclusions are superseded by RC23's measured ones. The branch is
left intact rather than deleted, because its run archives are the only record of
what the pre-RC23 harness produced — evidence of the defect, not of the system.
