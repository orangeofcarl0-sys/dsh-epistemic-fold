# R31 Persistence

## 1. Authority decision

R31 converged on one production authority:

| Store | Authority |
|---|---|
| DSH session log | raw events, anchor declarations/transitions, checkpoint retirements, and the historical fold proof |
| EF semantic journal | accepted semantic operations and immutable commit receipts |
| State projection | deterministic replay of events + verified commits at their historical positions |

The session log is **not** a second semantic authority. R30 wrote
`plugin:epistemic-fold/semantic` records on hosts with `appendPluginRecord`;
R31 reads those records only as a migration source. The installed API is
experimental and its format migration is best-effort, which is exactly why it
cannot be the sole production authority (the requirement in §C1).

Anchor and retirement events remain session facts. They use the sanctioned
`plugin:` transport where available and the raw `ef/*` event on the explicitly
in-memory face; one reader (`efPluginRecordOf`) accepts both.

## 2. v4 on-disk format

```text
<semanticRoot>/<sessionId>/<packetId>.json            prepared packet (immutable)
<semanticRoot>/<sessionId>/<packetId>.receipt.json    commit receipt (immutable)
<semanticRoot>/<sessionId>/<packetId>.v3.json         archived migration source
```

Prepared packet (`schemaVersion: 4`) carries:

- identity: `packetId`, `sessionId`, `checkpointId`, `mode`, `authority`;
- span: `foldedSeqs`, `spanDigest`;
- content: `bodyDigest`, `sourceDigest`, `stagedAtSeq`;
- resolved operations: `ops` (and `plannedOps` for shadow);
- audit: `proposed`, `accepted`, `refused`, `handoff`, `workingSet`, `writer`.

Receipt carries:

- `packetId`, `sessionId`, `checkpointId`;
- `outcome`: `committed` | `aborted` | `archived-only`;
- `proof` for `committed` (see `R31_COMMIT_PROOF.md`);
- `opsDigest`, `decidedAt`, `reason`.

`staged` is the absence of a receipt. There is no mutating `setStatus`: a
receipt is written once. Writing an identical packet/receipt is a no-op; writing
different bytes for the same identity throws. A receipt for a packet that does
not exist throws.

## 3. Atomicity

Both writes use DSH's atomic-write primitive (same-directory temp file + rename)
and then read the file back byte-for-byte. A short write or torn rename is the
one failure that would look like a decision, so it is checked. The same-directory
rename is atomic on one filesystem; this is **not** a distributed transaction
with the session log.

### Cross-store cases

| Session log | Journal | Correct action |
|---|---|---|
| committed | no receipt | re-prove the log, then write the committed receipt |
| committed | committed receipt | verify the receipt proof still matches; apply |
| no proof / older log | committed receipt | `conflict`; do not apply, do not re-append |
| aborted / no commit | no receipt | write an abort receipt |
| committed | aborted receipt | receipt is final; do not activate (a different decision already exists) |

The first row is tested by `tests/semantic-recovery.spec.ts` and by the
two-process crash case (`EF_NO_RECEIPT=1`) in
`tests/semantic-process-restart.spec.ts`.

## 4. Replay order

Packets are ordered by `receipt.proof.commitOrder`, which is the replacement
event's seq. Ties are broken by packet id. `stagedAtSeq` orders receipt-less
packets; wall time is never used.

`replayWithSemanticCommits()` folds the session events with the projection's
own reducer and applies each commit's operations immediately after its
replacement event. A commit at seq 100 cannot overwrite a raw event at seq 150.
Multiple commits at one seq are applied in packet-id order, so two runs with the
same files produce the same state regardless of directory enumeration order.

`tests/semantic-replay-order.spec.ts` covers an earlier commit + later raw
event, an earlier raw event + later commit, same-seq ordering, and an unplaced
commit (reported, never applied).

## 5. Concurrency

- All reconciliation paths for one session pass through
  `runSemanticLocked()`.
- One file per session means two **processes** on the same session can both
  attempt a write. v4 does not pretend the atomic rename is a lock: a different
  packet/receipt for the same id throws instead of choosing a winner. The
  engine treats a failed receipt write as `unrepairable` and reports `partial`.
- Multi-process writing is therefore safely *refused*, not coordinated. A
  single-writer deployment is the supported model.

## 6. Migration

### v3 journal packets

Read separately (`JournalRead.legacy`), never applied. For each:

1. require the bundle; `sourceDigest = bundle.archive.logicalHash`;
2. re-prove the fold against the session log;
3. write a v4 prepared packet (same `packetId`, schema 4, authority journal);
4. write a committed/aborted receipt;
5. move the old file to `<packetId>.v3.json` (audit) and skip it on later passes.

No bundle → no migration; the packet is reported `unrepairable`. A v3 packet
cannot prove its own source content.

### Legacy session records

`plugin:epistemic-fold/semantic` (or raw `ef/semantic`) is read, but only
migrated when the bundle and the historical proof agree. The record's resolved
ops are carried into a v4 packet; the span digest is derived from `foldedSeqs`.
A record whose fold cannot be proven is not converted.

### Unknown data

An unreadable packet/receipt is counted in `JournalRead.invalid` and makes health
`partial`. An unknown event type in the log is still handled by DSH's own
fail-closed persistence validator; EF does not bypass it.

## 7. Fork

A DSH fork copies events through an inclusive boundary and assigns a new session
id. On the child's first active reconciliation:

- read the parent journal; if its directory is absent, mark the child
  `blocked` (Active writing withheld) because an empty child state cannot be
  distinguished from lost parent state;
- for each parent committed receipt with `commitOrder < inheritedEventCount`,
  re-prove against the child log and write a child-owned packet + receipt;
- never inherit a commit at or after the boundary;
- if any seed proof disagrees with the child log, block.

A blocked child still folds deterministically with a state-only body and a
visible `(semantic continuity withheld: …)` line; it stages no new semantic
packet. `/context` reports `partial`.

## 8. What the journal is not

- It is not proof that a fold committed; the log proof is.
- It is not proof that a checkpoint is resident; the surface is.
- It does not retire checkpoints; retirement is a session record plus a surface
  operation.
- Its file's existence does not make state current; only a verified committed
  receipt does.
