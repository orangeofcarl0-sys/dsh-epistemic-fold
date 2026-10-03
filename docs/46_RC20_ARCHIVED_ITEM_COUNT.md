# RC20 — The archived-item count was reachable all along

While building RC19 I decided not to show *how many items* the folds took off the
surface, on the stated ground that the count "only exists in the bundle store,
which a pure projection cannot read". That was wrong, and a background search
that finished afterwards said so: DSH's own UI derives the same count from the
event log.

## 1. The claim, and its refutation

The reasoning was: `compaction/summary` carries `shadowedTokenCount` but no
message count; the message count lives in EF's bundle (`archive.shadowedMessages`);
and a pure event fold cannot read the bundle store. Every step is true and the
conclusion does not follow, because the event carries something else:

```ts
// vendor/.../session-format-v0-to-v1/src/dispositions.ts
'compaction/summary': disposition(
  ['compactionId', 'summary', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount', …],
  […],
),
```

`shadowedSeqs` is the seq of **every node in the folded region**, so its length is
the count. DSH's own conversation view computes it exactly that way:

```ts
// vendor/.../client/ui-chat/src/client/conversation-nodes/command.ts
shadowedItemCount = Array.isArray(data.shadowedSeqs)
  && data.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
  ? data.shadowedSeqs.length
  : null
```

The mistake was reading "the message count is in the bundle" as "the count is
unavailable", when a different, coarser count was in the event all along.

## 2. What it actually counts

Not messages. Measured on a real session (211 items):

| event type | count |
| --- | --- |
| `user/message` | 48 |
| `assistant/message` | 82 |
| `tool/result` | 81 |
| **total** | **211** |

So the label is **items**, not "messages" — a distinction that would have been
easy to get wrong by trusting the name `shadowedSeqs` and the bundle's
`shadowedMessages`.

## 3. The implementation

`FoldStatusState` gains `archivedItems`, accumulated from each
`compaction/summary`. The validity rule is DSH's own, applied per entry:

```ts
const seqs = (event.data as { shadowedSeqs?: unknown }).shadowedSeqs
const archivedItems = state.archivedItems
  + (Array.isArray(seqs)
    && seqs.every(seq => Number.isSafeInteger(seq) && (seq as number) >= 0)
    ? seqs.length
    : 0)
```

A malformed array contributes **nothing** rather than a wrong number. A
`length`-only implementation would report `2` for `['a','b']`; verified
destructively — weakening the guard to `Array.isArray(seqs) ? seqs.length : 0`
fails the test with `expected 5 to be 3`.

The token figure accumulates independently: a bad seq list must not suppress a
good token count, and the test asserts both.

State version bumped to 3, so a row persisted at 2 — which lacks the field —
is discarded rather than forward-applied as `undefined`.

## 4. What the panel shows

```
归档历史
归档 token      133k
归档条目        211
```

The token figure says *how much*; this says *how much stuff*. Both are needed to
answer "what did folding do to my session", and only one was on the panel.

Observed live, matching the session log exactly.

## 5. Lesson

The unavailable thing was a *specific* measurement — the number of messages, which
genuinely lives in the bundle — and I generalised it to "no count is available".
The event carried a coarser count the whole time.

This is the second time in this panel's history that the gap was not "the data is
missing" but "I looked at one source and concluded from it" (RC19 §4 is the
first). The cheap check that catches both is to ask what the *event* carries
before asking what the *store* carries — and, when a platform ships a UI for the
same fact, to read how that UI gets it.
