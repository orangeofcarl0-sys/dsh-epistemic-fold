# RC1.3.1 — Temporal Retrieval Guard

Baseline: `main@7b22fe2` (RC1.3 merged).
Scope: chronological correctness of retrieval ONLY. Keyless only — no new live soak.

> **One-line result.** Three chronology defects made `context_search` answer
> "what is the current value?" wrongly on any task with more than one checkpoint
> or more than one version of a fact. All three are fixed and pinned by 20 keyless
> tests. **The retrieval layer is now frozen.**

---

## 1. Why this stage exists

RC1.3 closed the retrieval-ergonomics gap on a probe where **all three facts lived
in one message of one checkpoint**. That is the easy case, and it hid three
defects that only appear once a task is long enough to fold more than once, or
once a fact changes value:

| # | defect | consequence |
| --- | --- | --- |
| 1 | `search` applied `limit` during an ascending scan | the **newest** checkpoints were the ones dropped |
| 2 | `locate` returned the **first** matching message | a superseded value shadowed its own correction |
| 3 | `exactPageOffset` was page-aligned for the default size | only "a page containing the match", and only for that page size |

Each one makes the model read an **old** value as current — the most damaging
class of error for an agent working from folded history, because the answer looks
well-sourced.

---

## 2. Defect 1 — the limit dropped the current value

`FileBundleStore.list()` sorts by ascending `createdAt`, and `search` used to
`break` as soon as it had `limit` hits. So with more matching checkpoints than the
limit, the scan kept the **oldest** and discarded the newest.

The reproduction is exact. Three checkpoints — C1 `timeout=30`, C2 `=60`, C3
`=90` — and `limit: 2`:

```
before:  [C1 (30), C2 (60)]        <- the current value, C3, is gone
after:   [C3 (90), C2 (60)]        <- newest first, limit = "the most recent N"
```

**Fix.** Match the full set first, order it, then slice. The limit now means "the
most recent N" rather than "the N earliest in the store".

## 3. Defect 2 — the first match shadowed the correction

`locate` returned the first matching message. In a single long turn, the original
value and its correction are two adjacent messages, so the hit pointed at the
**superseded** value and the excerpt showed it. A model reading the excerpt would
report `30` while `90` sat one message later.

**Fix.** `locate` scans the whole archive and reports the **newest** match, plus
two new fields:

- `matchCount` — how many messages matched. A count above 1 is the signal that
  this fact has **history**, so the model should expect a newer value.
- `earliestMatchedMessageIndex` — where the oldest match is, so the superseded
  value stays reachable without paging the archive from zero.

The scan order also changed: **archive before checkpoint text.** The archive is
raw history; the checkpoint text is a derived summary. When both carry the query
the archive is the more actionable answer, because it is what recall returns
verbatim and it is where the message-level chronology lives.

## 4. Defect 3 — the offset only worked at one page size

`exactPageOffset` was `floor(index / 20) * 20`. That is "a page containing the
match" only if the caller uses `limit = 20`: with the match at index 23 and
`limit = 2`, offset 20 returns messages 20–21 and **misses it**.

**Fix.** Removed in favour of `matchedMessageIndex`, which is the match's own
index. Used as the recall `offset`, the page **begins** at the match, which is
correct for **any** limit. The tool description now says so, and a test proves the
non-default page size case the old field got wrong.

## 5. The chronology key is the conversation, not the clock

Ordering uses `source.orderedSurfaceSeqs` — the span the fold actually shadowed —
not `createdAt`:

```
newest-first:  by (range.last, range.first) descending
fallback:      createdAt descending, only for a bundle with no sequences
tie-break:     checkpointId, so the order is total
```

`createdAt` is a wall-clock reading, so it can run backwards, collide (two folds
in the same millisecond), or simply disagree with the conversation. The sequence
span is the conversation's own record of where a checkpoint sits, so it is
authoritative for "which value came later". A bundle with **no** sequences never
outranks a sequenced one — an unsequenced bundle cannot claim to be current. Ties
break on `checkpointId` so the same query always returns the same order instead of
inheriting filesystem read order.

Each hit now carries `sourceRange` (`{first, last}`), so a model can see *where*
in the conversation a hit came from rather than trusting a timestamp.

---

## 6. What is deliberately unchanged

- **Superseded values remain fully reachable.** Newest-first is not newest-only:
  the archive keeps every version, `matchCount` announces that history exists, and
  `earliestMatchedMessageIndex` locates the oldest. A test asserts the superseded
  `30` and `60` are both still returned.
- **`recall` is untouched.** Paging, `EXACT_PAGE_LIMIT`, and the bounded-page
  contract are unchanged; only the *recommended offset* changed.
- **No compression-architecture change, no `semanticMode` change, no new live
  soak.** Per the directive, this stage is keyless only.

---

## 7. Verification

20 new keyless tests in `tests/rc131-temporal-guard.spec.ts`. They build bundles
with **explicit** sequence numbers and timestamps — so chronology is controlled
rather than inherited from wall-clock timing — and write through the **real**
`FileBundleStore`, so the store's own ordering is genuinely exercised instead of
stubbed away.

| group | pins |
| --- | --- |
| recency key | orders by sequence; **ignores `createdAt` when they disagree**; unsequenced bundles never outrank sequenced; total, antisymmetric, repeatable |
| cross-checkpoint | C1/C2/C3 newest-first; **`limit: 2` still returns C3**; superseded versions still reachable; inverted timestamps do not reorder |
| same-checkpoint | points at the newest match, not the first; `matchCount` and `earliestMatchedMessageIndex`; archive preferred over checkpoint text |
| recall offset | the offset is valid at the default **and** a non-default page size; the oldest offset reaches the superseded value |
| real fold path | a session that folds repeatedly reports its checkpoints newest-first, ordered by real engine-produced sequences |

Full suite: **528 keyless tests pass, 20 skipped, typecheck clean.**

### 7.1 The live suite was re-run, not assumed

Changing the hit ORDER could have hidden the RC1.3 facts (they live in the OLDEST
checkpoint, which newest-first ordering now returns last). So the RC1.3 live suite
was re-run after the change rather than reasoned about:

| arm | n=9 mean | search calls |
| --- | --- | --- |
| `unhinted` | **3.00/3** | 9/9 runs searched |
| `hinted` | **3.00/3** | 9/9 |
| `unhinted-legacy` | 1.00/3 | 3/9 |

Taxonomy: `primary pass: 9`, `recommended action: none — freeze the quality side`.
Non-regressive, and the guard's own keyless test on the real fold path confirms
why: on this workload only ONE of the 14 checkpoints matches the query, so
newest-first ordering cannot displace it.

---

## 8. The retrieval layer is frozen

Per RC1.3.1 §6, a green temporal/multi-hit guard is the stop condition. This
closes the third and last of the retrieval questions:

\[
\boxed{
\text{Compression architecture CLOSED}
+
\text{Recall correctness CLOSED}
+
\text{Retrieval ergonomics CLOSED}
}
\]

Frozen together: the fold/frontier architecture, the `context_search` hit shape,
the `context_recall` depths and paging, the chronology ordering, and the
`FOLD_FRAMING_SECTION` retrieval rule. These reopen only if a **new incident
corpus** produces evidence against them — not for further tuning.

### The one thing still open

\[
\boxed{\text{route-level realized cost gate = OPEN}}
\]

Nothing in RC1.3.1 touched it. It remains the only open question, and it is a
**pricing** question: it decides whether `economy` is *recommended* or made the
*default*, and it must not drive the context architecture to grow. If a future
measurement closes it, the outcome is a recommendation change — not a new
mechanism.

---

## 9. Files

| file | change |
| --- | --- |
| `src/recall.ts` | `sourceRangeOf`, `compareCheckpointRecencyDescending`; `search` orders then limits; `locate` returns the newest match with `matchCount` / `earliestMatchedMessageIndex`; `exactPageOffset` removed in favour of `matchedMessageIndex`; archive preferred over checkpoint text |
| `src/tools.ts` | `context_search` documents newest-first ordering, `matchCount`, and `matchedMessageIndex` as the recall offset |
| `src/index.ts` | exports the ordering helpers and the new types |
| `tests/rc131-temporal-guard.spec.ts` | NEW — 20 keyless tests |
| `tests/rc13-retrieval-ergonomics.spec.ts` | the offset assertions now verify a real recall page at `matchedMessageIndex` |

## 10. Corrections to earlier stages

- **RC1.3 §2.1's `exactPageOffset` is superseded.** It was a page-aligned offset
  presented as "the page that holds the match", which is true only at the default
  page size. `matchedMessageIndex` replaces it and is correct at every size.
- **RC1.3's conclusions are otherwise unaffected.** Its probe had one matching
  checkpoint, so defects 1 and 2 were unreachable there and defect 3 never fired;
  its measured results (2.33 → 3.00/3) stand. The RC1.3 live suite was re-run
  after this change and still measures 3.00/3 with search in 9/9.
