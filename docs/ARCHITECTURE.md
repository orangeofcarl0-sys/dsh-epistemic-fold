# Epistemic Fold Architecture

## 1. Model

Epistemic Fold treats long-agent context as a working set over a more durable record.

```text
Canonical truth
  ├─ DSH session events
  └─ Fold bundles / artifacts
          │
          ▼
Deterministic projection
  ├─ current state
  └─ open trajectory
          │
          ▼
Checkpoint compiler
          │
          ▼
Frozen prompt surface
          │
          ├─ recent open tail
          └─ search / recall → bundles
```

The architectural statement is:

```text
History ≠ Memory ≠ Context
```

History is the durable record. Memory is what the system can recover or derive. Context is what the model needs in the next request.

## 2. Core contract

EF is built around these rules:

1. **Truth is not rewritten by compaction.**
2. **Lossy surface reduction happens only after durable provenance exists.**
3. **Narrative summaries are not authoritative state.**
4. **Unresolved constraints / failures / obligations must not disappear silently.**
5. **Normal folding advances a monotonic Fold Frontier.**
6. **Frozen-surface changes use the same compaction transaction path.**
7. **Recall is bounded, exact where requested, and provenance-backed.**
8. **Compression is judged by closed-loop behavior, not summary similarity.**

The earlier RFC lists these as a larger numbered invariant set; this document keeps only the current architectural contract. See [01_EF_RFC_001_ARCHITECTURE.md](01_EF_RFC_001_ARCHITECTURE.md) for the historical specification.

## 3. Fold transaction

A candidate fold is a contiguous legal span of the model-visible surface.

```text
surface before
────────────────────────────────────────────
frozen checkpoints | frontier | open span | tail
                               └── candidate
```

The transaction order is important:

```text
select candidate
      ↓
write exact CheckpointBundle
      ↓
derive state / checkpoint body
      ↓
commit DSH surface replacement
      ↓
re-derive frontier
```

The bundle write must succeed before the lossy replacement commits.

### CheckpointBundle

A bundle contains the information needed to verify and recover the fold:

- checkpoint id / mode;
- exact shadowed model-visible messages;
- canonical hash;
- rendered checkpoint;
- optional semantic output and usage metadata;
- source/provenance information.

Bundle files are written atomically with restrictive permissions.

## 4. Fold Frontier

The Fold Frontier separates frozen context from the open trajectory.

```text
[Frozen C1][Frozen C2][Frozen C3] | [Open turns...]
                                   ^
                               frontier
```

Normal Leaf Folds operate only after this boundary. This avoids recursive summary-of-summary rewriting and improves prefix stability.

The frontier is derived from the current surface rather than trusted as an independent mutable pointer.

## 5. Leaf and Root folds

### Leaf Fold

The default incremental maintenance path:

- choose a legal open span;
- archive it;
- replace it with an EF checkpoint;
- leave earlier frozen checkpoints byte-stable.

### Root Fold

A rebase over a larger frozen region:

- used when the recurring carry cost becomes worth the one-time prefix mutation;
- evaluated with provider/model economics rather than a universal "always merge after N folds" rule;
- normally executed through the idle maintenance path.

Root folds are deliberately rare.

## 6. State and authority

EF has a normalized vocabulary for bounded current state:

```text
objective
constraint
decision
value
artifact
evidence
failure
obligation
```

The state reducer is deterministic and supports supersession/lifecycle semantics.

The authority rule is more important than the vocabulary:

```text
Raw Events ──► State
     │
     └──────► Narrative Summary

Narrative Summary ─X─► authoritative State
```

A model-written rationale may explain a checkpoint, but it cannot independently verify a fact or close a failure.

## 7. State ownership and current limitations

The vocabulary above is representational. EF does not replace canonical owners already present in DSH.

| domain | canonical owner | EF |
| --- | --- | --- |
| completion goal | DSH goal service | does not duplicate |
| current plan / todo | DSH planning/todo | does not duplicate |
| project guidance | `AGENTS.md` / instruction loader | does not duplicate |
| failed tool results | raw `tool/result` | automatic EF state derivation exists |
| temporary session assertions | no universal owner | representable; no general producer |
| decisions/evidence/artifacts/obligations | no universal owner | representable; no general producer |

Custom `ef/anchor` events are authority-gated, but durable persistence depends on whether the host can preserve plugin-event envelope metadata. On hosts that cannot, EF must fail closed rather than write a session log the host cannot reopen.

## 8. Recall

Compaction must not make information unrecoverable.

### Search

`context_search` scans folded bundles and returns bounded pointers/excerpts. The current contract includes:

- conversation-chronology ordering;
- newer matching evidence preferred;
- older matches remain reachable;
- exact matched-message indices;
- bounded verbatim excerpts;
- explicit provenance.

### Exact recall

`context_recall` can return the checkpoint view or exact archived messages. Exact pages are sourced from the archive, not reconstructed from a summary.

## 9. Prefix and cache economics

EF optimizes prefix stability, but prefix stability is not itself a correctness invariant.

Provider cache economics differ. A warm token can be much cheaper than a cold token, yet it still consumes context window and may increase latency.

The policy therefore separates:

```text
correctness constraints
      ↓
provider/model economics
      ↓
leaf/root decision
```

The economics model can account for uncached input, cache reads/writes, auxiliary compaction calls, recall, and context pressure.

## 10. Operating modes

All tiers resolve to ordinary configuration values; there is no mode-specific branch in the engine.

```text
Economy
  retain 0.16
  semantic none

Balanced
  retain 0.24
  semantic none

Quality
  retain 0.24
  semantic rationale
```

This makes the ladder attributable: Economy → Balanced changes retention; Balanced → Quality changes semantic redundancy.

`legacy` is EF's compatibility baseline. `basic` delegates to the vendored Basic backend and mounts no EF user/model surface.

## 11. Observability

`/context status` and the Sidebar consume the same status model.

They report:

- current pressure/window/threshold;
- archived history estimate;
- current checkpoint count;
- lifetime fold counts;
- search/recall activity;
- provider usage;
- estimated route cost when a price profile exists.

This observation path is outside model history.

## 12. Non-goals

Current EF deliberately does not implement:

- a vector database;
- learned compression policy;
- generic embedding memory;
- multi-level checkpoint generations;
- semantic dependency graph;
- universal tool-output compression;
- automatic cross-session memory runtime.

Several of these were explored or bounded experimentally and were deferred because the measured value did not justify the added correctness seam.

## 13. Main implementation map

| subsystem | file |
| --- | --- |
| compaction engine | `src/engine.ts` |
| fold candidates / frontier | `src/candidate.ts`, `src/frontier.ts` |
| bundle storage | `src/bundle-store.ts` |
| checkpoint compiler / renderer | `src/compiler.ts`, `src/renderer.ts` |
| deterministic state | `src/state.ts`, `src/authority.ts` |
| search / recall | `src/recall.ts`, `src/tools.ts` |
| provider economics | `src/economics-profile.ts`, `src/policy-compiler.ts` |
| mode presets | `src/preset.ts` |
| status / commands | `src/status.ts`, `src/command.ts` |
| client projection / Sidebar | `src/status-projection.ts`, `client.js` |
| DSH integration | `src/plugin.ts`, `cordis.patch.yml` |
| Basic compatibility backend | `src/basic/` |
