# Semantic Continuity — the transaction

> **R31 supersedes this document's commit predicate.** v3 activated only when
> the replacement was on the CURRENT surface. v4 proves the historical fold
> transaction and treats residency as a separate fact. See
> `R31_COMMIT_PROOF.md` and `R31_PERSISTENCE.md`.

This document states what the implementation actually commits, and when. The
short version: **a staged packet is not state, and a fold is not committed
because a file exists.** State changes only after the model-visible surface has
been replaced.

## Vocabulary (used consistently)

| Term | Meaning in this implementation |
|---|---|
| **prepared** | The candidate, span, and bundle identity exist. Nothing durable about semantics yet. |
| **proposed** | The writer returned text. Parsed or not; untrusted. |
| **validated** | Evidence, kind/authority, and status checks passed. Still not state. |
| **resolved** | Supersession targets were resolved against the projected state, producing concrete declare/transition/retire operations. Still not state. |
| **staged** | The packet file is durable (journal). **Not state.** It may never activate. |
| **committed** | Basic appended `compaction/summary` AND the replacement `user/message` is on the model-visible surface. The fold's body is law. |
| **activated** | The packet's operations are part of the state projection (session record appended, or journal status `activated`). |
| **visible** | The model can read the checkpoint body on the surface. |
| **recovered** | A later reconciliation proved the commit from the log and repaired a missing activation. |

These are deliberately distinct. Collapsing "staged" into "committed" is the
defect this layer was built to avoid.

## Who owns what

- **Session log** — the archive and the raw evidence. Never rewritten by EF.
- **Bundle** — the durable checkpoint body and its archive. Written before
  Basic's checks; a bundle can exist for a fold that never committed.
- **Semantic journal** — staging, and (on hosts without a record writer) the
  authority for semantic state.
- **`plugin:epistemic-fold/semantic` record** — on DSH 0.2.1+, the durable commit
  record for one packet. Appended only after the commit predicate passes.
- **State projection** — session-derived state plus committed semantic records
  (session-record authority) or activated journal packets (journal authority).
- **Surface** — the only thing the model reads, and the authority for "did this
  fold commit".

## The sequence

```
Basic:      compactRegion / compactIfNeeded / compactNow
   |
   +-- compaction/start                      (lock; durable)
   |
   +-- summarize()                           [EF compile hook]
   |     reconcileSemantics()                (repair prior packets)
   |     project state                       (records or activated journal)
   |     writer (one call, or rationale in shadow)
   |     validate -> resolve -> candidate state
   |     render temporal body
   |     journal.write(packet, status=staged)  <-- staging
   |     buildBundle + bundle.write          (archive)
   |     return body to Basic
   |
   +-- assertStable                          (shrink + stability; may THROW)
   +-- compaction/summary                    (commit point, text includes body)
   +-- user/message with surfaceOp: replace  (surface commit)
   +-- compaction/end                        (clean close)
   |
   +-- session/event observer (microtask)
         classify each staged packet:
           body digest matches + replacement on surface -> activate
           summary with a different body               -> abandoned
           summary present, replacement not on surface  -> archived-only
           log unchanged                                -> pending
```

The observer is a microtask because `Session.append` refuses a reentrant append
while it publishes. By the time the microtask runs, Basic's synchronous commit
block (`summary` + `replace` + `end`) has finished.

## Packet state machine

```
                  write
                   |
                   v
                staged -------------------------------> abandoned
                   |   no matching body, log advanced        ^
                   |                                        |
                   +---- exact body + surface message ------+--> activated
                   |                                              |
                   +---- summary, replacement not on surface ----> archived-only
                   |
                   +---- log length unchanged --------------------> pending (stays staged)
```

Only `activated` contributes state. `archived-only` and `abandoned` are terminal
diagnostics; `pending` is retried on the next fold/event.

## The commit predicate (why the surface, not the end marker)

`compaction/summary` alone is not enough. `commitCompactionBody` appends the
summary and then the replacement message in one synchronous block; if the
replacement throws, the summary exists while the model never sees it. The fold
failed. Conversely, if the replacement landed and only `compaction/end` failed,
the fold succeeded — the model is reading that checkpoint.

The predicate therefore requires BOTH:

1. `canonicalHash(summaryText) === packet.bodyDigest` — the exact body. A
   truncation retry can produce a different body under the same checkpoint id;
   only the body that landed may activate.
2. The next event is a `user/message` whose derived source is
   `compact-checkpoint`, and its seq is in `session.surface.nodes`.

`compaction/end` is a close marker, not the authority.

## Authority split (one truth per deployment)

At construction, `pluginEventTransport()` decides:

- `plugin-record` → **session-record authority.** Activation appends
  `plugin:epistemic-fold/semantic`; the projection folds it; the journal is
  staging and diagnostics.
- anything else → **journal authority.** Activation rewrites the packet status;
  the state projection layers activated packets over the session-derived state.

A packet records its authority. Reconciliation never reinterprets a packet under
the other authority. The one exception is an explicit UPGRADE migration: an
already-activated journal packet, on a deployment that now has records, is
appended once as a record (its state was already part of the fold chain).

## Fault matrix

| Injected at | Session log | Journal | Projection | Surface | Recovery |
|---|---|---|---|---|---|
| writer fails | `start` … `end(error)` | no packet | unchanged | unchanged | fold fails; health `partial`; retry |
| validation refuses all deltas | fold continues | packet with 0 ops | unchanged | state-only body | fold commits; no semantic state |
| staging write fails | no packet | torn temp removed | unchanged | — | fold ABORTS before the bundle; safe |
| bundle write fails | `start` … `end(error)` | staged packet | unchanged | unchanged | packet later `abandoned` |
| shrink rejection | `start` … `end(error)` | staged packet | unchanged | unchanged | `abandoned` (tested) |
| span stability rejection | `start` … `end(error)` | staged packet | unchanged | unchanged | `abandoned` |
| surface replacement fails | summary, no replacement | staged packet | unchanged | old body | `archived-only` |
| crash after replacement | summary + replacement | staged | missing state | new body | restart: classify → activate |
| record append fails after commit | no record | staged | missing state | new body | next fold/startup reconciles and re-appends |
| journal status write fails after commit | record present | staged | state present (record) | new body | next reconcile rewrites status |
| restart, journal authority | summary + replacement | activated | replay | new body | idempotent (tested) |
| two processes race one packet | both see the log | atomic rewrite | whichever status lands | — | same body digest; no duplicate anchor ids |

## Idempotency

- `deltaId = canonicalHash(kind, subjectKey, statement, status, evidence seqs)`;
  `anchorId = 'semantic-' + deltaId[0..32]`.
- `packetId = canonicalHash(schema, sessionId, checkpointId, foldedSeqs, bodyDigest)`.
- Replaying a packet applies the same declare ids. A second declare at the same
  coordinate with the SAME id does not create a self-supersession entry
  (verified in `semantic-core`).
- A packet already activated is skipped by `packetId`; a record already present
  is not appended again.

## What the journal is NOT

- It is not proof of commit. A packet may be staged forever; only the log's
  commit predicate activates it.
- It is not a second state projection. Its packets are applied through the same
  reducer, and only while the deployment's authority is `journal`.
- It is not a replacement for the archive. Evidence quotes reference message
  seqs; the messages live in the session log and bundles.
