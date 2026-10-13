# 72 — LHTB host wiring for the active task root

Status: host wired and verified (keyless, real bridge); live continuation OPEN. 2026-10-14.
Parent `4f0dd07`.

## 1. The host says which message, the arm says whether it counts

The engine could protect a registered root; nothing registered one. The gap was the HOST.

`ef_lhtb_agent.py` flags the append that carries the instruction (`task_root=True`), because the
host is the only party that knows which message it is. Nothing infers an objective: "the first
user message" is a heuristic, and protection resting on it would protect whatever a fixture
happened to send first.

The flag is a DECLARATION, not a decision. `taskRootMode: off | exact` decides:

| value | behaviour |
|---|---|
| `off` (default) | registers nothing; the episode is unchanged |
| `exact` | registers the flagged event as the ACTIVE TASK ROOT |
| `engine: 'basic'` | forced off in the host, whatever the config says |

NOT derived from the arm name, and not from the tier: enabling protection is a decision about the
EXPERIMENT. Inferring it would change what an existing arm measures with nobody choosing it. The
mode is applied in `EpistemicFoldBridge` (env `EF_LHTB_TASK_ROOT_MODE`), so the arm table keeps
stating what each tier IS while the mode stays a run-level choice.

Registration happens INSIDE the flagged append -- after the event exists, so its seq and digest are
real, and BEFORE any model call, so the first request already runs under the protection the arm
asked for. Verification re-derives the event through `engine.taskRootStatus` instead of trusting
the registration.

## 2. Telemetry

`telemetry.taskRoot` reports `mode`, `status` (`unregistered` | `resident` | `absent`), `sourceSeq`,
`digestVerified` and `surfacePosition`, and NEVER the instruction: this block is archived with every
cell's transcript, and benchmark content does not belong there.

## 3. Verified through the real bridge

`tests/task-root-bridge.spec.ts` drives the REAL bridge process over its JSON-line protocol against
a local fake provider, so the run is keyless while exercising the real adapter, session, fold
transaction and telemetry:

* the flagged instruction is registered, with `digestVerified` and the instruction's own seq;
* a real LEAF fold commits and does NOT shadow it, and the root stays resident afterwards;
* with the mode `off` the same setup DOES shadow it -- the switch is load-bearing, and the two
  arms must not be pooled;
* `engine: 'basic'` forces the switch off even with `taskRootMode: 'exact'`.

## 4. The forced-root op, and a measured harness limit

`{"op":"rootCompact"}` forces ONE root fold (closing the harness turn around it, because a manual
compaction requires an idle session by contract).

**In this harness it cannot commit**, and the reason is not task roots: `compactNow` passes a
durability barrier (`ctx.sessions.flush`), and the bridge creates a bare in-memory session the store
has never seen, so it fails with `session "..." is not live in this store`. Basic's own `compactNow`
passes the SAME barrier, and a test asserts the identical refusal on the basic arm -- so it is the
HARNESS's limit, measured, not this change's. The op reports the cause CHAIN rather than Basic's
`busy` wrapper, which alone says "requires an idle agent" for every failure mode there is.

## 5. Live smoke: OPEN

One controlled run through the real bridge against the real provider route (Economy + TaskRoot):

```
init: true
taskRoot@append: {"mode":"exact","status":"resident","sourceSeq":2,"digestVerified":true,"surfacePosition":0}
pre-fold reply: ""          providerFailures: 2
fold committed: 0            folds: 0
taskRoot@afterFold: resident
taskRoot@afterRoot: resident
```

**What this does verify live:** the host declared the root, and the engine verified it against the
real provider session -- `digestVerified: true`, the real `sessionSeq` 2, surface position 0 -- and
it stayed resident across the attempted folds.

**What it does NOT verify:** a real fold and a real post-fold continuation. Both model calls failed
at the provider (`providerFailures: 2`, empty replies), so no turn completed and no pressure was
ever reached. Per the round's instructions this is reported rather than retried until it looks good.

## 6. Verdict

**`LIVE OPEN`.** The host wiring is verified (keyless through the real bridge, and live up to the
declaration); the real-model post-fold continuation the round asked for did not happen, and is not
claimed.
