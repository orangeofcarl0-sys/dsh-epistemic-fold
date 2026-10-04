# RC22 — Storage, revision traceability, and two experiments

A review round that started from a question about **disk pressure** and ended up
touching the archive encoding, the revision model, and the bundle's own
integrity — because the measurements kept pointing at things that were wrong
rather than merely large.

Nothing here changes what a default deployment does except the checkpoint
line format and the R1 report numbers it produces. The two new capabilities are
**off by default**.

## 1. The measurement that started it

`<DSH_HOME>/.epistemic-fold` held **1.0 MB** across 4 sessions. Small. The
interesting part was the ratio, measured per session against the log holding the
same content:

| session | session log (disk) | bundle store | share |
| --- | ---: | ---: | ---: |
| `b444c006` | 1.78 MB | 949 KB | **53%** |
| `4e2cd154` | 56.6 KB | 20.7 KB | 37% |
| `0f86c86e` | 40.2 KB | 9.3 KB | 23% |
| `696736a4` | 42.3 KB | 6.6 KB | 15% |

Three structural facts explained it, and each became work:

1. **The log is stored compressed, the bundle was not.** The 1.78 MB log expands
   to 6.6 MB — 3.71x. So one byte of content cost ~3.7x more in a bundle.
2. **The archive is pre-prune.** All 8 bundles, 230 archived messages:
   `[... tool result middle pruned ...]` appeared **0 times**. EF archives what
   the model saw, before DSH's read-side pruner rewrites the view.
3. **Content is stored once.** 230 archived messages, 230 distinct, **0**
   duplicated across bundles. The Fold Frontier works: growth is linear, not
   superlinear.

There was also **no reclamation at all**: `FileBundleStore.remove()` existed with
zero callers.

## 2. Bundles are compressed (commit `8f3ca30`)

The one saving that costs nothing semantically: the archive is append-only cold
data, and `logicalHash` covers the archived MESSAGES rather than the file, so
re-encoding cannot change what was archived.

Level chosen by measurement, not by taking the maximum:

| level | size | ratio | compress |
| --- | ---: | ---: | ---: |
| 3 | 109 KB | 8.6x | 3.5 ms |
| **9** | **100 KB** | **9.4x** | **14.7 ms** |
| 19 | 93 KB | 10.2x | 179.9 ms |

Level 19 buys 7% for 12x the time, and this runs **inside the fold
transaction** — the path whose job is to relieve context pressure.

On a copy of the real store: **982,984 → 151,888 bytes (6.5x)**, all 8 logical
hashes intact. The read path is not slower: it reads 6.5x fewer bytes and
decompression is ~2 ms per bundle.

Reading is deliberately tolerant — `decodeBundleFile` accepts a bare bundle as
well as an envelope, because installs that already folded have uncompressed
files on disk. Base64 rather than raw bytes because the store writes through
`writeFileAtomic`, which takes a string.

## 3. The referential archive (commit `ae72f66`, EXPERIMENTAL, off)

Facts 1-3 above mean the archive is largely a second copy of content the log
owns. Measured directly: **200 of 211** archived messages were byte-identical
(deep-equal, key order aside) to the event payloads at the seqs the bundle
already recorded.

So a bundle can identify its history instead of copying it. On a copy of the
real store: **982,984 → 26,436 bytes (37x)**.

What makes a ref trustworthy is the **digest**, not the seq. A bare seq proves
"fetch from here"; `(seq, digest)` proves "this position still holds what I
referenced". Without it a changed `deriveEventMessage`, a rewritten surface, or a
migrated log would silently resolve to different content. The digest is over the
**derived message**, not the raw event, because the archive stores derived
messages.

Three properties make it safe:

- `messageCount` and `logicalHash` are present in BOTH forms, so a referential
  bundle still states its span length and its archive identity. `verify` checks
  the shape it can check and says so, rather than pretending to check bytes it
  does not have.
- an unresolvable archive is **reported** (`unavailable`), never served as an
  empty page — a short page looks complete to the model.
- `buildArchiveRefs` refuses refs whose count disagrees with the archive, so a
  bundle's own two fields cannot contradict each other.

### Cross-session recall is a separate switch

Also off. Recall is session-scoped by construction (R0-A), so serving a foreign
checkpoint means opening a stored log that may be concurrently written,
archived, or migrated.

It **range-reads** rather than replaying. Measured on a real 1.9 MB log (1914
frames): structural frame scan 7.2 ms, decoding the ~10 frames a checkpoint
needs **2.6 ms**, full decode **132.4 ms** — a 50x difference. It resolves
through the same standalone `deriveEventMessage`, so a ref resolves identically
whether the session is loaded or read back from disk.

The owner lookup is an OPTIONAL store method, so a store without it degrades to
"not found" rather than throwing.

## 4. A root fold's seq refs did not identify its archive (commit `473e472`)

Found while auditing a real session: **bundle seqs 212, archived messages 211**.
`commit.shadowedSeqs` — Basic's own result — agreed with 211, so the **bundle**
was the side that was wrong, and the extra seq was the **retained tail**.

`selectCompactableRange` deliberately retains a tail, so the folded span is a
PREFIX of the surface. A root fold has no candidate span, so `currentSpanSeqs`
fell back to "the whole current surface" and appended one node the fold never
covered. On the fixture: surface `[1,4,…,46]`, folded span ends at 44, and 46 was
appended in error.

This is not cosmetic: a bundle whose refs over-count its archive cannot become a
reference-only manifest, because the refs would name content the fold never
covered. **The archive length is now the authority** for how many surface
positions the fold covers, and a leaf span that disagrees fails loud rather than
being silently trimmed to fit.

## 5. The checkpoint body is bound to the state it projected (commit `473e472`)

The body presents a model-facing view of the deterministic state (Current /
Evidence / Open). Nothing recorded **which** state it projected, so a rendering
or reducer defect would show the model a snapshot that had silently diverged
from what the log derives — the ghost-memory / governance-decay shape.

The bundle now records `state.digest = canonicalHash(state)` plus the visible
anchor count, written **only when a projection was mounted** (absence is
informative, not missing data). A reader re-derives and compares: equal means the
checkpoint still shows what the log supports.

The count is a cheap structural companion: a digest mismatch at equal count
points at a changed value, an unequal count at a lost or duplicated anchor.

## 6. Revisions are now traceable, and anchors addressable (commit `760c96a`)

Two gaps found by asking what "confirm a cognitive modification" would need.

### The revision was a count, not a chain

The reducer removed the displaced anchor and raised `retiredCount`, so a consumer
could learn that something changed but not **what**, or which anchor replaced it.
`supersededBy` existed as a field and was **never written anywhere in the
repository** — it appeared only in the type and the schema.

Now the displaced anchor is retained once per coordinate, marked
`lifecycle: 'superseded'`, with `supersededBy` pointing at its replacement:

```
superseded["scope/cli/flags"] = { id: C1, value: 30, lifecycle: superseded, supersededBy: C2 }
stateHeads["scope/cli/flags"] = { id: C2, value: 60, lifecycle: active }
```

Bounded by **coordinate**, not by revision count: one entry per state key, the
latest displacement. A third revision replaces the chain entry rather than
growing it (pinned by test). Unbounded history is what the session log is for.

This is what an undo needs, and what a preservation check needs — TrustMem's
verifier compares `(M_t-1, M_t)`, and EF previously could not produce `M_t-1` at
all.

### The chain is deliberately NOT rendered

It is metadata for programs. A model shown the old AND the new value at one
coordinate is the ghost-memory confusion this keeps out of the prompt, so
`projectForCheckpoint` never reads `superseded` — and a test fails if a future
change starts rendering it.

### State anchors are addressable

`anchorLine` carries the id, matching `failureLine`, which always has. A model
that wanted to revise or retire a constraint could describe it but not **name**
it, so "confirm this change" had nothing to point at:

```
- [constraint anchor-addressable scope/work/public-api] Do not change public API. (normative)
```

The format is not a parsing contract — `splitLeafCheckpointText` splits on
section headers, never on bracket content — which is what lets the id be added
without a reader change.

### Two consequences

`stateVersion` **1 → 2**. The projection contract is explicit that this must be
raised when serialized fields change, so a persisted row from the old unit is
discarded and re-folded rather than forward-applied into a state that looks
valid and has quietly lost the chain.

The ids **cost real tokens**, and the R1 report moved because of it — only on
W2-state-rich, the one state-carrying workload:

| | before | after |
| --- | ---: | ---: |
| EF total | 102,831 | 106,949 (**+4.0%**) |
| checkpoint-state | 23,083 | 28,716 |

Correctness gates unchanged (ALR=0, SSR=0, ProvenanceCoverage=100%). The report
is regenerated with the change because CI diffs it.

## 7. What was NOT done, and why

**A cognitive-state ledger (StateCommit journal + risk-graded gates + two-phase
deletion).** A proposal on the table, declined on evidence: `ef/anchor` has
**0 writes across 256 real sessions**. The only automatic producer is
`applyToolResult`, deriving a failure anchor from a failed tool result. The
economy tier makes no model call, so no LLM-generated state exists to corrupt.
Building a governance layer for a layer with no content is a lock on an empty
room.

The literature cited for it is real (Governance Decay: constraint violations
0% → 30% after compaction, 38% when the constraint is dropped; MoM: supersede-
and-mark beats overwrite 100% vs 25% on revision chains). But those measure
"LLMs frequently rewriting memory", which EF does not currently do. §6 is the
part that was worth taking now, because it is a prerequisite for that work
rather than the work itself.

**A sidecar journal for `ef/anchor`.** Also declined: `dsh-base` already mounts
`session-projection-cache`, so EF's state projection **is** already persisted
(version-stamped, discarded on version mismatch, explicitly "a fold shortcut,
never authoritative"). The proposal's premise — that only an in-memory current
value exists — was wrong. The real gap was the chain, and §6 closed it.

**Bundle reclamation.** `remove()` still has no caller. Deliberately left: the
only painless fix (compression) is done, and any retention policy trades against
the exact-recall promise, which is a product decision rather than a cleanup.

## 8. Verification

- Full suite: **823 passed, 23 skipped** (81 files).
- `typecheck` and `typecheck:client` clean; `build` and `preflight` current.
- CI green on both lanes (pinned `0.1.7-rc.2` and master) for every commit.
- Destructive checks, each confirming a new assertion is load-bearing:
  - reverting the root-fold fallback → `m2-frontier` fails (16 vs 15);
  - making the state digest constant → 3 tests fail, including the divergence
    detector;
  - ignoring the ref digest → the drift test fails;
  - removing the own-checkpoint guard → the cross-session test fails;
  - dropping the chain write → `S03b` fails;
  - rendering the chain → `S03c` fails.

## 9. Lesson

The disk question was answered in one measurement, and then the same
investigation found a **correctness** bug (seq refs over-counting their archive),
a **detection** gap (no binding between a checkpoint body and the state it
shows), and a **traceability** gap (`supersededBy` declared and never written).

The ratio that started it — 53% — was real but minor. The three defects found
while measuring it were not. That is the pattern worth keeping: cost questions
are cheap to answer, and answering them properly puts you inside the code paths
where the expensive mistakes live.
