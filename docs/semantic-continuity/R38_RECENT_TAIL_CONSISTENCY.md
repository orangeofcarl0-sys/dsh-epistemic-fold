# R38-M0 — Recent-Tail Consistency

## 1. The window

```text
t1  user approves the in-memory queue
t2  a fold commits that decision at seq N
t3  user approves the durable outbox at seq M > N
t4  the agent starts a new request
```

The t2 state is correct at its commit point. It is stale at delivery. An
assembler that reads only the semantic journal can hand the model the t2 value
as the ONLY current decision while the raw log already contains a newer user
instruction.

## 2. What is produced

An assessment, not a commit:

```ts
{
  snapshot: {
    semanticCommitWatermark,   // highest commitOrder in projected state
    sessionEventWatermark,     // seq the task frame was built from
    archiveRevision,           // checkpoint id / digest of the archive view
    taskFrameRevision,
  },
  snapshotDigest,
  anchors: [{ anchorId, stateKeyText, committedAt, verdict, laterEventSeq, reasons }],
  safeAnchorIds,
  unsafeAnchorIds,
  warnings,
  frameStale,
}
```

The overlay can carry `warnings` and the snapshot. It must not silently splice
state from one time point with events from another.

## 3. Verdicts

```text
no-later-event             no raw event after the commit watermark
no-effect                  later events exist, none names this anchor
superseded-by-user         a later user message shares the claim and carries a cue
requires-reconciliation    a real candidate the text does not prove
scope-different            the later event belongs to another scope
```

`safeToAssertAsCurrent` is true for `no-later-event`, `no-effect` and
`scope-different`. Everything else produces a warning that names the commit seq,
the later seq, and the reason.

## 4. Two strengths, never one guess

A deterministic system cannot know that "approve the durable outbox" revokes
"use the in-memory queue" unless the texts share a subject. The assessment
therefore separates:

**Strong** — the later user message shares a token of the CLAIM (not the
coordinate) and carries a revision cue (`switch`, `instead`, `revoke`,
`approve`, `decide`, `prefer`, …). For a `decision` or `constraint` this is
`superseded-by-user`.

**Weak** — the later user message is relevant to the task frame, the anchor is
also relevant, and there is a cue, but the texts do not share a claim token.
This is `requires-reconciliation`, not a revision. The system refuses to assert
the old value as the only current one and says why.

Using the claim rather than the coordinate matters: a coordinate like
`scheduler-queue` contributes `scheduler` and `queue` to every scheduler
message, so coordinate matching would call every task-relevant note a revision.
The coordinate is still used for frame relevance, because it says which part of
the task the anchor belongs to.

## 5. Authority rules

```text
tool observation  + normative/decision anchor  -> no-effect
tool observation  + empirical anchor           -> requires-reconciliation
assistant message + normative anchor           -> no-effect
assistant message + decision/empirical         -> requires-reconciliation
user message      + empirical anchor           -> requires-reconciliation (not superseded)
```

A tool result cannot revoke a user constraint. An assistant proposal cannot
override one. A user instruction does not revoke a measurement; it may change
its relevance.

## 6. Results

`eval/r38/out/recent-tail-consistency.json` — 9/9 checks.

| Case | Unsafe anchors | Frame stale |
|---|---|---|
| no-tail-update | — | no |
| explicit-user-revision | queue, depth | no |
| weak-task-signal | queue, depth | no |
| tool-observation | depth | no |
| assistant-hypothesis | — | no |
| different-scope | — | no |
| concurrent-advancement | queue, depth | yes |
| no-evidence | — | no |

- The explicit revision marks the queue `superseded-by-user`; the depth finding
  is `requires-reconciliation` (a user instruction does not revoke a
  measurement).
- The weak signal marks the queue `requires-reconciliation`, never
  `superseded-by-user`.
- The tool observation leaves the release constraint `no-effect` and marks the
  empirical depth finding for review.
- The assistant message leaves the constraint `no-effect`.
- The different-scope event is `scope-different`, and no anchor is unsafe.
- The concurrent-advancement case reports `frame-stale` because the frame
  watermark is 8 while the session has an event at 14.

## 7. Determinism and restart

The assessment sorts anchors by id before hashing, so a rebuilt state and a
permuted input produce the same `snapshotDigest`. `runDeterminism` asserts
first = second = reordered.

## 8. What this does NOT do

- It does not write the t3 decision into the journal. That needs a new fold and
  a validated commit; this module only prevents the overlay from asserting the
  old value as the only current one.
- It does not call a model. The strong/weak split is a fixed text rule.
- It does not decide that a `requires-reconciliation` anchor is wrong. It marks
  it unsafe to assert and asks for reconciliation.
- It does not compare timestamps across hosts. Ordering is by session seq.

## 9. Evidence

```text
eval/r38/src/recent-tail.ts
eval/r38/recent-tail.mjs
eval/r38/out/recent-tail-consistency.json   9/9 checks
tests/r38-recent-tail.spec.ts              10/10
```
