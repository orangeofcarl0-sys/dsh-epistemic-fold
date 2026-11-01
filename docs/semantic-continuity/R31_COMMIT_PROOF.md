# R31 Historical Fold Commit Proof

## 1. What was wrong

The R30 classifier asked:

```ts
session.surface.nodes.includes(replacementSeq)
```

That answers **"is the checkpoint resident now?"** It does not answer **"did
this fold commit?"** A checkpoint committed in fold F1 and folded into F2 leaves
the surface, so a staged packet from F1 was demoted to `archived-only` even
though its commit was a historical fact.

The opposite error was also possible: the classifier matched a body digest
anywhere and then required only residency, not transaction identity. A log
restored with different events at the same seqs could claim the packet.

## 2. The host transaction, measured from source

`@deepseek-ai/dsh-compaction-basic` appends the commit body synchronously:

```text
compaction/start      { compactionId, turn }
compaction/summary    { compactionId, summary, shadowedSeqs, shadowedRange, ... }
user/message          surfaceOp: { op:'replace', startSeq, endSeq }
                      source.kind = compact-checkpoint
                      sourceEventSeqs = [start.seq, summary.seq, ...shadowedSeqs]
compaction/end        { compactionId, turn, error? }
```

`commitCompactionBody()` appends summary and replacement without yielding.
`Session.append` validates the surface operation before committing the event, so
a replacement event in the append-only log is evidence that the surface
replacement was applied. `compaction/end` is appended after the replacement and
is a closure marker, not the commit point.

## 3. The proof

`src/semantic/proof.ts` returns one of four verdicts. Only `committed` carries a
proof and may activate state.

```ts
interface HistoricalFoldProof {
  proofVersion: 1
  sessionId, checkpointId, compactionId
  startSeq, summarySeq, replacementSeq
  endSeq?, endError?
  shadowedSeqs, spanDigest
  sourceDigest
  bodyDigest, summaryDigest
  commitOrder       // replacementSeq — the only replay order key
  unclosed
}
```

A `committed` verdict requires ALL of:

1. **Session identity** — `String(session.id) === packet.sessionId`.
2. **Packet self-consistency** — `canonicalHash(foldedSeqs) === spanDigest`.
3. **Marker identity** — the summary text parses and its `cp:<id>` equals the
   packet's checkpoint id.
4. **Body identity** — `canonicalHash(summary text) === packet.bodyDigest`.
5. **Transaction identity** — a `compaction/start` with the same
   `compactionId` precedes the summary.
6. **Span identity** — the summary's `shadowedSeqs`, in order, equal the
   packet's `foldedSeqs`; the proof's `spanDigest` hashes them.
7. **Source identity** — derive every span event's message, apply the fold's
   deterministic derived-answer retirement, hash the list, and compare to
   `sourceDigest` (the bundle's own `archive.logicalHash`).
8. **Replacement identity** — `summarySeq + 1` is a `user/message` with
   `surfaceOp.op === 'replace'`, `source.kind === 'compact-checkpoint'`, and
   `sourceEventSeqs` containing both the start and the summary.

Optional bundle check, when a bundle is available: it must name the same
session/checkpoint/span, its `rendered.digest` must equal the packet body digest,
and its `archive.logicalHash` must equal `sourceDigest`.

**Current residency is never consulted.**

## 4. The four verdicts

| Verdict | Evidence | Effect |
|---|---|---|
| `committed` | all eight facts above | write a committed receipt; ops become state |
| `aborted` | a summary with the checkpoint id and a different body; a compaction that ended without a summary; a summary with no replacement after restart | write an immutable abort receipt; never state |
| `unresolved` | the owning compaction is open and has not written a body; a summary is the last event and the fold is still executing in this process | leave the packet staged |
| `conflict` | identity/transaction/span/source evidence disagrees (missing start, different source bytes, packet span mismatch) | do not activate; report `partial` health |

`classifyPacket()` maps these to `activated` / `abandoned` / `archived-only` /
`pending` / `conflict` for consumers; activation still requires `committed`.

## 5. Partial-commit cases, explicitly

### Summary exists, replacement missing

Not committed. The bundle may be durable, but the model never saw the body.
After a restart the packet receives an `archived-only` receipt. While the fold is
executing in the same process (`inFlightCheckpoints`), it remains `unresolved`,
because the synchronous append block may still be in progress.

### Summary + replacement exist, replacement no longer resident

**Committed.** This is the defect the round was opened for. The proof is
recomputed from the log on every pass; residency is irrelevant.

### Replacement landed, `compaction/end` failed or is absent

**Committed.** The proof records `endError` / `unclosed: true` but does not
downgrade the commit. A non-essential closure marker cannot erase a surface
replacement that already happened.

### Same checkpoint id, different body

**Aborted.** A retry won and this body was never visible. The exact digest, not
the marker alone, decides.

### Log advanced past the staged seq with no summary

The proof does **not** infer failure from `session.seq > stagedAtSeq`. It locates
the compaction that was open when the packet was staged:

- that compaction ended → `aborted`;
- that compaction wrote another body → `aborted` (different body);
- it is still open with no body → `unresolved`.

## 6. Monotonicity and re-verification

In a complete, append-only log:

```text
once committed, always historically committed
```

A later Leaf, Root, or Exit cannot revoke the proof. The engine re-proves every
committed receipt on every reconciliation, which is monotonic for an unchanged
log.

The rule deliberately does **not** extend to a log that changed underneath the
journal. If the summary or replacement is absent, or the source content hash
differs, the receipt becomes a `conflict` and its operations are not applied.
The engine never re-appends a record to "repair" this: doing so would inject
future state into an earlier session backup.

## 7. Tests

`tests/semantic-commit-proof.spec.ts` builds real `Session` event transactions:

- committed, then folded away by a second fold → same proof before/after;
- summary without replacement → `aborted`; in-flight → `unresolved`;
- replacement + failed end → `committed` with `endError`;
- replacement + missing end → `committed` with `unclosed`;
- compaction ended without a summary → `aborted`;
- same seqs, different source content → `conflict`;
- packet span ≠ committed span → `conflict`;
- summary with no matching start → `conflict`;
- replacement without transaction citations → `aborted`;
- retry with a different body → `aborted`.

`tests/semantic-lifecycle.spec.ts` and `tests/semantic-process-restart.spec.ts`
exercise the proof through the production engine and a real JSONL reopen.
