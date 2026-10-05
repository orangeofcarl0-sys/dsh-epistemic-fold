# RC23 — The LongWork lane runs end to end, and three harness defects fell out

Phase 5 and the Phase 6 gate were executed against the real benchmark for the
first time since RC22. **Both arms completed their EF side cleanly.** Three
defects were found — all of them in the harness, none in the engine — and two of
them were only reachable *because* the `basic` arm was fixed.

## 1. What ran

| cell | arm | outcome |
|---|---|---|
| 1 | `basic` | completed clean: 43 model calls, 46 shell calls, `finish: stop` |
| 2 | `economy` | EF side clean: 230 model calls, 211 shell calls, 15 folds, `finish: stop` |

Both used `unknown-config-semantics` on the `space-bunny-free` route, one attempt
each, serial. The environment (Docker 29.7.2, the LHTB checkout, the pinned task
image) was already present; nothing needed installing.

## 2. The `basic` arm is finally Basic

This is the finding the whole exercise was for. Compare the telemetry the two
harnesses report for a `basic` arm:

| field | before (RC22 and earlier) | now |
|---|---:|---:|
| `archivedBundles` / `bundleWrites` | **3, 4, 15** | **0** |
| `bundlesPresent` | 3–4 | **0** |
| provenance block | absent | present, `rev 94ecab6` |

Real DSH Basic has no bundle store, so a non-zero archive count for a `basic` arm
is impossible. The old column was the proof, and it was read as a detail. With
`mode: 'basic'` set, the plugin returns early, no EF checkpoint is stamped, and
nothing is archived — which is what "versus DSH Basic" has to mean.

## 3. Three harness defects

### 3.1 The proxy was forced on, and the proxy does not work

`scripts/run-lhtb.sh` hardcoded `NODE_USE_ENV_PROXY=1` with
`HTTPS_PROXY=http://127.0.0.1:10808`, on the stated premise that "Node (the EF
bridge host) reaches the provider only through the local proxy". Measured:

| path | result |
|---|---|
| direct to `opencode.ai/zen/v1/models` | **200**, repeatedly |
| through `127.0.0.1:10808` | **000**, repeatedly |

A Node fetch through that proxy dies with a bare `fetch failed`, which the bridge
reports as `error:fetch failed` — naming neither the proxy nor the port, so it
reads like a credential or route fault. The proxy is now opt-in
(`EF_USE_PROXY=1`).

### 3.2 The summarization budget truncated Basic checkpoints

The harness passed `maxTokens: 2000`. That field is not the agent's reply budget
(that is `EF_BRIDGE_MAX_TOKENS`); it is what the engine hands its own checkpoint
call — `summarize()` uses `config.maxTokens`. Basic's full-checkpoint format is
far larger than EF's marker-only body, so at 2000 the summary hit the cap and the
fold failed closed:

```
summarization truncated at the token cap (incomplete checkpoint)
```

That ended a trial with `BridgeError` and reward 0 — **after** the agent had made
nine substantive shell calls against the task. It surfaced only once the `basic`
arm built a real Basic engine; the EF arms' marker-only checkpoints fit in 2000,
so a too-small budget was invisible for as long as every arm was EF. Raised to
8192 (`EF_TAU2_SUMMARY_MAX_TOKENS`).

### 3.3 The span guard compared nodes against messages

The sharpest one. `currentSpanSeqs` derived a bundle's seq refs and refused the
fold when the span's **surface node** count differed from the archive's
**message** count:

```
epistemic-fold: leaf fold span has 20 surface node(s) but archived 19
message(s); the bundle's seq refs would not identify its archive
```

Those are not the same quantity. `deriveEventMessage` returns `null` for events
that carry no message, and Basic's own summarization input filters those out
(`src/basic/region.ts`: `.map(…).filter(message => message !== null)`). A span of
N nodes can therefore archive fewer than N messages, legitimately.

It fired on the `economy` arm after **five folds had already committed**, and
ended the episode with `BridgeError` and reward 0. The guard was right to refuse
a bundle whose refs do not match its archive; it was comparing the wrong two
numbers. Both the leaf path and the root-fold fallback now count **derived
messages**.

After the fix, the same arm ran to **15 folds** with `folds == bundleWrites`
throughout and `pendingIntents: 0`.

## 4. What the fixed arms then did on the task

The `economy` arm's agent solved most of the task — the first time any EF arm has
done so:

```
STAGE B: ok 94 bad 0
STAGE C: ok 738 bad 0 rows 246
STAGE D: fields 110 bad 0
```

Its own closing message reports stages A, C and D solved and verified, and it
failed on the last verification step because the shell became unreachable.

## 5. The one failure that is not ours

The `economy` cell ended with `AddTestsDirError` and a compose teardown returning
`3221225794` (`STATUS_CONTROL_C_EXIT`). Both are Harbor/Docker infrastructure, not
EF: the container had been pinned at 4 GiB / 4 GiB for over an hour, and the
daemon survived. The EF side had already finished cleanly (`finish: stop`, 15
folds, nothing pending) — the failure came in Harbor's post-run step.

**This is recorded rather than worked around.** Raising the container's memory
limit would change the benchmark's own declared resource envelope, which is the
benchmark's decision, not this repository's.

## 6. Not claimed

- **No reward comparison.** `basic` scored 0.0 and `economy` did not produce a
  score at all, so nothing here ranks the arms. One attempt each is not a sample.
- **No cost claim.** `economy`'s realized cost was $0.20 for 230 model calls on
  one task; `basic`'s was $0.05 for 43. Different amounts of work were attempted,
  so the figures are not comparable.
- **No claim that the lane is fixed.** Two cells on one task, one of which died in
  Harbor's teardown. The lane is *runnable* and the harness now measures the
  production configuration; a sweep is still the thing that would produce
  evidence.

## 7. Verification

- **884 passed, 23 skipped, 0 failed**; three typecheck projects clean
  (`tsconfig.json`, `tsconfig.client.json`, `tsconfig.eval.json`).
- Six new guard suites, each verified destructively where a reproduction exists:
  `harness-typecheck`, `harness-basic-arm`, `harness-maintenance-lifecycle`,
  `harness-recall-tools`, `convergence-telemetry`, `convergence-contract`,
  `convergence-overflow`, `convergence-property`, `bundle-span-agreement`.
- **One guard is honest about being partial.** `bundle-span-agreement` asserts the
  refs-resolve-to-archive invariant, but reintroducing the 3.3 defect leaves it
  PASSING: a synthetic `conversation()` session has no node that fails to derive a
  message, so `span.length === messageCount` and the two forms are
  indistinguishable. Only the live run produced that node. The limitation is
  written in the test rather than papered over.
