# R32 — Semantic Commit Integrity

**Contract:** no Semantic Operation reaches authoritative state unless it is
bound to a valid Prepared Packet, the matching Commit Receipt, the packet's real
operations, and a Historical Fold proven from the session log.

This document describes the implementation in
`src/semantic/{ops,integrity,journal,replay,proof}.ts` and how every state path
consumes it.

---

## 1. The one validated value

```ts
interface ValidatedSemanticCommit {
  packetId: string
  sessionId: string
  checkpointId: string
  commitOrder: number          // the replacement event's seq
  proof: HistoricalFoldProof   // re-derived from THIS log
  operations: readonly EfAnchorEventData[]
}
```

`validateSemanticCommit(options)` is the only producer. Its result is:

```ts
type SemanticCommitValidation =
  | { status: 'valid'; commit: ValidatedSemanticCommit; missingReceipt: boolean }
  | { status: 'aborted'; reason; detail; receipt? }
  | { status: 'pending'; detail }
  | { status: 'conflict'; code: SemanticIntegrityFailure; detail }
  | { status: 'invalid'; code: SemanticIntegrityFailure; detail }
```

`valid` is the only status that can contribute operations to replay. `aborted`
and `pending` are benign historical states: they never add operations, and they
do not block new folds. `conflict` and `invalid` block Active writing.

## 2. Checks, in order

### 2.1 Packet runtime schema

`isSemanticPacket` now checks every field that decides state:

* schema 4, non-empty packet/session/checkpoint ids;
* body, source, and span digests;
* `mode` ∈ {off, shadow, active};
* `authority` ∈ {journal, session-record};
* `status` ∈ {staged, activated, abandoned, archived-only};
* integer `stagedAtSeq`, finite `createdAt`, integer `foldedSeqs`;
* `handoff` string, `deltaParse` enum, `proposed`/`accepted`/`refused` arrays;
* `ops` through the runtime operation validator.

A shallow `typeof` check is not enough: the reader is inspecting JSON an earlier
process wrote, not a value TypeScript already checked.

### 2.2 Operation schema (`src/semantic/ops.ts`)

One validator is shared by the journal writer, journal reader, integrity gate,
and legacy record reader.

| Operation | Required shape |
|---|---|
| `declare` | complete `anchor`: non-empty id ≤512, known kind, `stateKey` of three non-empty strings, `value` present (any JSON), known authority, known lifecycle, optional valid failure state, optional scope of known string fields, array of valid `{seq}` refs |
| `transition` | non-empty `anchorId`, known `failureState`, optional evidence refs; a `verified` transition REQUIRES at least one evidence ref |
| `retire` | non-empty `anchorId` |

`ops: [null]`, a declare without a state key, an unknown lifecycle, a transition
with no target, and a retire with no id all fail at `validateOps`.

### 2.3 Native v4 identity

For a native packet the journal recomputes:

```text
packetId = canonicalHash({
  schema: 4,
  sessionId,
  checkpointId,
  foldedSeqs,
  bodyDigest
})
```

and refuses a mismatch. It also requires
`spanDigest === canonicalHash(foldedSeqs)` and `authority === 'journal'`.

Legacy v3 ids were produced by a different algorithm. `isLegacySemanticPacket`
never applies the v4 identity. Migration re-derives the id, writes it as a v4
row, and records the original id in `legacyPacketId`.

### 2.4 Receipt binding

A receipt must satisfy all of:

* schema 4, `kind: 'receipt'`, non-empty packet/session/checkpoint/ops digests;
* `receipt.packetId === packet.packetId`;
* same session id and checkpoint id;
* `receipt.opsDigest === canonicalHash(packet.ops)`;
* a `committed` receipt carries a proof; an `aborted`/`archived-only` receipt
  carries none;
* the proof names the packet's session, checkpoint, body digest, span digest,
  source digest, and exact span, with `commitOrder === replacementSeq`.

`journal.writeReceipt` applies the binding before writing; `journal.list`
applies it again when associating files. A receipt that exists but does not bind
is a **rejected receipt**, not a missing one.

### 2.5 Historical proof

The proof is re-derived from the session log by `proveFoldCommit`:

* session identity;
* exact summary body by checkpoint marker and `canonicalHash(text)`;
* compaction id shared by start and summary, with the start before the summary;
* the packet's span equals the summary's `shadowedSeqs`, in order;
* the summary's `shadowedRange` equals the first and last shadowed seq;
* archived source content re-derives to the packet's `sourceDigest`;
* the next event is a `user/message` replacement whose `surfaceOp` range equals
  the summary's range, whose source is `compact-checkpoint` with the SAME
  `compactionId`, and whose `sourceEventSeqs` equal
  `[startSeq, summarySeq, ...shadowedSeqs]` exactly and in order;
* `compaction/end` is a closure observation only: a committed replacement stays
  committed if the close is missing or records an error.

The fresh proof must equal the recorded proof on every commit-identity field.
`endSeq`, `endError`, and `unclosed` are deliberately excluded: a receipt
written before the close landed is not contradicted by the close arriving later.

## 3. Journal association

`FileSemanticJournal.list` produces:

```ts
interface JournalRead {
  packets: SemanticPacket[]
  receipts: Map<string, SemanticReceipt>       // only bound pairs
  legacy: SemanticPacket[]                     // v3 migration candidates/archives
  invalid: { file; detail; code? }[]           // structurally unusable rows
  orphans: { file; packetId; detail }[]        // receipt with no packet
  rejectedReceipts: Map<string, string>        // packetId -> why its receipt failed
  state: 'ok' | 'valid-empty' | 'unreadable'
}
```

The association is one-to-one:

| Situation | Journal result | State effect |
|---|---|---|
| packet + bound receipt | `packets` + `receipts` | may replay if proof committed |
| packet, receipt missing | `packets` only | recovery may write receipt after re-proof |
| packet, receipt rejected | `packets` + `rejectedReceipts` + `invalid` | blocked; NEVER treated as missing |
| receipt, packet missing | `orphans` + `invalid` | blocked |
| file stem ≠ payload id | `invalid` | blocked |
| packet id ≠ v4 identity | `invalid` | blocked |
| duplicate packet/receipt identity | `invalid` | blocked |
| malformed JSON | `invalid` (`corrupt`) | blocked |
| directory unreadable | `state: unreadable` | blocked / unavailable |

`rejectedReceipts` is the reason the modified-packet case is fail-closed:
without it, the engine would see "no receipt" and use the missing-receipt
recovery path to bless the modified operations.

## 4. Where the gate is consumed

| Path | Uses |
|---|---|
| `semanticAdmissionOf` (fold-time state) | `validateJournal` → `validateSemanticCommit` → `replayWithSemanticCommits` |
| `reconcileSemanticsUnlocked` | `validateJournal` → writes only missing/repaired receipts |
| `replayWithSemanticCommits` | parameter type is `ValidatedSemanticCommit`; no raw `ops` field exists |
| `inheritForkSemantics` | parent `receiptBindingProblem`, child `validateSemanticCommit`, expected-set verification |
| `migrateLegacy` | constructs a v4 row, then `validateSemanticCommit` before writing |

`proveFoldCommit` remains a lower-level historical primitive and does NOT enforce
the v4 packet-id algorithm. It is also used to re-prove a legacy candidate
before the converted row exists; enforcing the native id there would make
verified migration impossible.

## 5. Missing receipt vs conflict

| Situation | Verdict | Action |
|---|---|---|
| Packet + receipt valid, proof committed | `valid`, `missingReceipt: false` | replay; no write |
| Packet, no receipt, proof committed | `valid`, `missingReceipt: true` | write committed receipt; replay |
| Packet, no receipt, fold unresolved | `pending` | leave staged |
| Packet, no receipt, fold aborted | `aborted` | write final non-activation receipt |
| Receipt committed, proof no longer matches | `conflict` | block; never rewrite |
| Receipt committed, proof unresolved | `conflict` | block; never re-grant |
| Receipt rejected (ops/session/checkpoint/body) | `conflict` / `invalid` | block; never treat as missing |
| Receipt says aborted, log proves committed | `conflict` | block |

## 6. Replay

`replayWithSemanticCommits(session, commits, { uptoSeq? })` folds the session
with the projection's own reducer and applies each validated commit immediately
after the event at `commitOrder`. Ordering is by `commitOrder`, then packet id;
wall time is never consulted. A commit whose `commitOrder` is absent from the log
is reported `unplaced` and is NOT applied at the end. `semanticAdmissionOf`
turns any unplaced commit into a block.

## 7. Legacy and compatibility

* v3 packets are read as migration candidates only. The `.v3.json` archive is
  kept after conversion.
* Conversion requires a verified bundle (`archive.logicalHash` supplies the
  source identity), a historical proof, valid ops, and a v4 id.
* A session-record (`ef/semantic`) is the same migration source. It cannot
  become state without the bundle.
* An unmigrated active legacy row is a blocker until it converts or is
  quarantined; a `.v3.json` archive whose id is listed in a v4 packet's
  `legacyPacketId` is audit-only and not an outstanding migration.
* A v4 packet whose id is not the v4 identity is refused. This includes any
  R31-era migrated row that preserved a v3 id; its `.v3.json` archive remains
  available for a fresh verified migration.
