# Handoff

> **R31 supersedes the readiness and rollback guidance below.** Use
> `R31_HANDOFF.md` for the current Active-mode verdict, gates, migration, fork
> limits, and blockers.

## What is ready

| Surface | State | Evidence |
|---|---|---|
| `semanticContinuity: off` | unchanged from main | full suite baseline |
| `semanticContinuity: shadow` | **trial-ready on any host** | visible body byte-identical to `off`; no state, no journal file; one recorded extra call |
| `semanticContinuity: active` (in-process / vendored 0.1.7) | **trial-ready** | stage → commit → activate → restart-replay tested |
| `semanticContinuity: active` (real 0.2.1 host) | **transport verified; full process restart not yet exercised** | `appendPluginRecord` writes an ignorable record the host validator retains |

Active mode is no longer structurally blocked on the real host: the sanctioned
`appendPluginRecord` API exists in 0.2.1-rc.1+. What remains unverified is a
full process restart through the real JSONL backend (see
`HOST_COMPATIBILITY.md`), not the write path itself.

## Enabling it

```yaml
- name: dsh-epistemic-fold
  config:
    semanticMode: rationale          # required; "none" is the zero-LLM profile
    semanticContinuity: shadow       # start here
    semanticWorkingSetTokens: 1024   # 128..8192; 512-2048 is the intended range
    semanticRoot: <profile persistence root>/semantic
```

Promote to `active` after inspecting `/context`:

```
semantic continuity: active (ready)
  packets         3 accepted, 1 refused, 3 committed
  working set     ~1037 tokens (estimated)
```

Health meanings:

- `ready` — no staged packets are waiting, and the last writer parsed.
- `partial` — a writer failed, a packet is pending, or a packet was abandoned.
- `stale` — a committed record was missing from the log and was re-appended.
- `archive-only` — configured `off`, or packets exist but none is on the surface.
- `unavailable` — the journal could not be read/written.

## Rolling back

1. Set `semanticContinuity: off` and restart. The writer stops; committed
   semantic anchors remain in the session state (they are ordinary anchors in
   the projection), so nothing breaks.
2. On **session-record** authority the session log is the truth. The journal is
   staging/diagnostics and may be deleted; recovery is unaffected.
3. On **journal** authority the activated journal files ARE the semantic state.
   Deleting `semanticRoot` discards that state; the checkpoint bodies already on
   the surface still mention it until the next root fold. For a clean rollback,
   set `off`, keep the directory, and let the next root fold rebase.
4. `stateVersion` is 3. Downgrading to a build with version 2 discards the
   projection row and re-folds; plugin records in the log are ignored by an
   older reader (they are `ignorable`).

## Known limitations

- **Live semantic quality is not measured.** No `EF_LIVE`, no provider route on
  this machine. The scripted matrix (B0=1/6, B1=1/6, S1=1/6, S2=6/6) proves the
  pipeline and the representation, not extraction quality. Do not present it as
  a task-quality result.
- **Generalization guard is a token list**, not semantic entailment.
- **Ambiguous quotes are refused**, which can drop a real repeated constraint.
- **Journal writes are atomic per file, not locked across processes.**
- **The vendored test runtime is 0.1.7-rc.2** while main declares >=0.2.0-rc.2.
  This pre-existing mismatch fails `rc3-plugin-packaging` and is not resolved by
  this work.

## The next concrete tasks

1. **Real-host restart test.** Mount the 0.2.1 JSONL backend with the host's own
   cordis context, write a semantic record, close the handle, reopen, validate,
   project, and fold again. This closes the last Gate B gap.
2. **Live semantic evaluation.** Run the same six scenarios with a real provider
   under B1/S1/S2, record real usage (missing usage = `unknown`), and grade
   whether the model's next action respects the constraint, avoids the rejected
   approach, and verifies the unfinished change.
3. **Exit interaction.** The frozen chain measured 101,659 tokens over 100 folds
   in the pure simulation. Combine the temporal body with the existing Phase Exit
   and root rebase, and measure whether exit removes the remaining growth.
4. **Resolve the vendor/version drift** (`vendor/deepseek-harness` at 0.1.7 vs
   `engines.dsh >=0.2.0-rc.2`) and the install-time `cordis.patch.yml`
   regeneration, so both are environment setup rather than test failures.
