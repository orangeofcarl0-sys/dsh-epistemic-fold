# Semantic Continuity v1 — Specification

Status: **implemented, keylessly verified; not live-model verified.**
See `EVALUATION.md` for exactly what is and is not established.

This document describes what the code actually does, not what it was intended to
do. Where a design decision was changed by measurement or by a defect found
during implementation, the reason is stated.

---

## 1. The gap this closes

EF before this round was a reliable *archive and compressor*. It could prove
that folded history was durably stored, that the archive was hash-verifiable,
that the fold frontier was monotonic, and that checkpoints could be recalled
exactly. What it could not do was answer a different question:

> after a span of conversation leaves the model's context, which of the things
> said in it must still influence what the agent does next, and is that state
> still valid?

The deterministic state (`src/state.ts`) only ever learned about the world from
two sources: explicit `ef/anchor` operations and failed tool results. A user's
"never commit to main", a decision reached in prose, a failed approach the team
ruled out — none of it became state unless a human or a test declared an anchor
by hand. The state was *correct about what it knew* and silent about almost
everything else.

Semantic Continuity adds one narrow, auditable path from conversation to state,
and one bounded path from state back into the model's context.

---

## 2. Data flow

```
                  ┌──────────────────────────── one model call ───────────────────────────┐
 folded span ───► │ rationaleOnly(instruction = SEMANTIC_WRITER_INSTRUCTION)              │
                  │   → <handoff> prose </handoff>                                         │
                  │   → <deltas> [ {kind, subjectKey, statement, status, evidence[]} ]     │
                  └───────────────────────────────────┬────────────────────────────────────┘
                                                      │  untrusted
                                          ┌───────────▼────────────┐
                                          │ validateDeltas          │
                                          │  quote → (seq, digest)  │  runtime-derived
                                          │  producer → authority   │  evidence only
                                          │  status → granted       │  never model-granted
                                          └───────────┬────────────┘
                             accepted ─────────────────┼───────────────── refused
                                 │                                        │
                    ┌────────────▼─────────────┐                (journal only)
                    │ journal packet (intent)   │
                    └────────────┬─────────────┘
                                 │  active mode only
                    ┌────────────▼─────────────┐
                    │ anchor-service.declare    │  → `ef/anchor` in the session log
                    │ (one sanctioned producer) │  → reducer → projection → state
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼──────────────────────────────────────┐
                    │ compileWorkingSet + renderTemporalCheckpoint       │
                    │  Changed in this fold (provenance-scoped delta)    │
                    │  State from earlier folds (bounded)                │
                    └───────────────────────────────────────────────────┘
```

### 2.1 One model call, not two

`src/semantic/writer.ts` supplies a different **instruction** to the existing
rationale call (`src/rationale.ts`), which now takes an optional `instruction`
argument. Provider, model, token budget, abort signal, finish-reason
classification and usage accounting are shared, so a semantic deployment cannot
acquire a second, differently configured LLM path — and a fold does not pay a
second round trip.

`semanticContinuity: shadow|active` **requires** `semanticMode: 'rationale'`.
The resolver refuses the combination with `semanticMode: 'none'` rather than
silently adding a model call to a configuration that promised none
(`src/policy.ts`).

### 2.2 Evidence is runtime-derived

The writer never supplies a `seq`, a digest, an anchor id, or an authority
domain. It supplies a **verbatim quote** (8–240 characters). The runtime:

1. searches the folded span's derived messages for that exact substring;
2. refuses a quote found in more than one message (`evidence-ambiguous`) — the
   question evidence answers is "which event says this", and a non-unique match
   does not answer it;
3. refuses a quote found only in a derived message such as a checkpoint
   (`evidence-derived`) — derived narrative is not an authority root;
4. derives `{seq, messageDigest}` itself, where the digest is
   `canonicalHash(derivedMessage)` — the same identity rule the checkpoint
   archive uses.

Consequence: a model cannot fabricate evidence, because a fabricated phrase does
not occur in the text it was shown.

### 2.3 Authority follows the producer, not the role

`user/message` is a role. DSH's own context producers (`agent-instructions`,
`workspace`, `notice`, `relay`, `recall`, `compact-checkpoint`, …) inject
user-role messages, each declaring itself in `Message.source.kind`. Only
`kind: 'user'` is the human.

`authority.ts` now exports `authoritativeKindOf(eventType, sourceKind)` and the
anchor service classifies a cited event by **role + producer together**.
Everything else is refused, and the refusal names the producer
(`8:context-injection`), so an operator can see why.

### 2.4 Three axes, kept separate

| axis | type | question | who moves it |
|---|---|---|---|
| `EpistemicStatus` | `claimed / hypothesis / observed / verified` | how well is this evidenced? | the runtime, from the cited sources |
| `SemanticLifecycle` | `active / superseded / retired` | is this still the effective value? | explicit operations only (the reducer) |
| `Residency` | `pinned / working / archived` | must it stay directly visible? | the working-set compiler, per fold |

Collapsing these is the usual origin of memory-system bugs: a `verified` claim
can be superseded, a `pinned` constraint can be merely `claimed`, and nothing
about age or retrieval frequency may revoke a user's requirement.

**Status granting.** The writer may *ask* for any status. The runtime grants:

- `verified` only when every cited source is empirical or procedural (a real
  tool result), otherwise it **downgrades** to `observed` (if a tool result is
  present) or `claimed`, and records `downgradedFrom`;
- `observed` only when a tool result is cited, otherwise `claimed`;
- a normative claim (`objective`/`constraint`/`obligation`) asserted as
  `observed` or `verified` is **refused** (`status-unsupported`): a user's
  sentence is asserted, not observed.

### 2.5 Kind → anchor mapping

| semantic kind | required authority | anchor kind | state coordinate |
|---|---|---|---|
| `objective` | normative | `objective` | `semantic/objective/<subjectKey>` |
| `constraint` | normative | `constraint` | `semantic/constraint/<subjectKey>` |
| `obligation` | normative | `obligation` | `semantic/obligation/<subjectKey>` |
| `decision` | decision | `decision` | `semantic/decision/<subjectKey>` |
| `rejected-approach` | decision | `decision` | `semantic/rejected-approach/<subjectKey>` |
| `finding` | empirical or procedural | `evidence` | `semantic/finding/<subjectKey>` |
| `failure` | empirical | `failure` (open) | `semantic/failure/<subjectKey>` |
| `experience-candidate` | hypothesis (forced) | *none* | journal only |

`entity` is the **semantic** kind, not the anchor kind, so a `decision` and a
`rejected-approach` about the same subject stay distinct coordinates even though
both render as `decision` anchors.

A `rejected-approach` anchor's value is
`rejected: <statement> (rules out: a, b)` — the reason is the retrieval cue. A
bare "we rejected Redis" invites re-adoption on the next fold.

**Statements are normalized to one line, and coordinates to ASCII.** Both are
correctness measures. A rendered state line is `- [kind id key] value
(authority)`; a statement containing a newline could emit a second line shaped
exactly like a runtime-authored anchor, including the trailing authority marker.
`subjectKey` is restricted to printable ASCII because state keys are
canonicalized and hashed, and `canonicalJson` sorts keys with `localeCompare` —
a non-ASCII coordinate could make two hosts compute different digests for
identical state. An oversized statement is refused (`statement-too-long`), not
truncated: truncating would store and hash a claim the model did not make.

---

## 3. State ownership and transaction boundaries

**State ownership is unchanged.** The `ef/anchor` session log and the
deterministic reducer remain the only source of truth. The semantic layer never
keeps a parallel map of current values; it emits *deltas*, and the reducer
decides what the current value is.

**The journal is audit, not state.** One atomically written JSON file per
packet, under `<semanticRoot>/<sessionId>/`, written before any anchor is
appended so an intent is durable even if the process dies. A `commit-<id>.json`
sidecar records what landed, and a `health-<id>.json` records the fold's health —
the latter matters because a writer FAILURE produces no packet at all, and
without it "no packet" would be indistinguishable from "the feature was never
configured". Losing the journal
costs idempotency and audit; it does not lose state, because the anchors are in
the session log. A journal file that is corrupt or from an unknown schema
version is skipped, never guessed at.

**Commit ordering inside one fold:**

1. writer call (no durable effect)
2. validation (no durable effect)
3. journal packet — the intent is durable
4. `ef/anchor` appends, one per accepted delta, declared **before** any
   cross-coordinate retirement (so a failed declare cannot delete the value it
   would have replaced)
5. journal commit sidecar — audit of what landed
6. re-read state → compile the working set → render the body
7. *caller* writes the bundle, then returns the checkpoint: `BundleDurable ≺
   SurfaceLoss` is preserved

If step 7 fails, or Basic refuses the fold at its shrink check, anchors from
step 4 remain for content that is still visible. That asymmetry is the safe
direction — additive state derived from visible history, nothing lost — and it
is why reconciliation compares against the **log**, not against a fold record.

### 3.1 Idempotency and restart

`deltaId = canonicalHash({kind, subjectKey, statement, grantedStatus, evidenceSeqs})`
and `anchorId = "semantic-" + deltaId.slice(0, 32)`.

Because the anchor id is **derived**, the session log alone answers "was this
delta committed?". `reconcileSemantics(session)` reads the journal's accepted
deltas, checks the log for the derived ids, and re-commits the missing ones.
The engine runs it at the start of every fold and exposes it publicly for tests.

**The oracle is the LOG, never the bounded state.** The current state keeps one
displaced anchor per coordinate by design, so asking it "was this committed?"
reports every twice-displaced anchor as missing — and re-declaring it makes an
old revision the current value again. That defect existed and was found in
review; a three-revision regression test now pins it (`anchorIdsInLog`,
`tests/semantic-continuity.spec.ts`).

**Repair re-checks the evidence.** Before re-committing, each cited message is
re-derived and hashed; a mismatch (a replaced surface, a migrated log) means the
delta is left missing and the health is `stale`. Repair is grouped per packet
and applied in two phases — every declare, then every retirement — so a delta
that supersedes a sibling is never lost to ordering.

**Commit order inside a packet is two-phase**, for the same reason. A retirement
executed immediately after its own declare is a no-op when its target is
declared later in the same packet, which left the replaced decision active
beside its replacement.

A retried fold re-validates against the journal's committed identities, so its
deltas are refused as `duplicate` instead of appending a second anchor.

**A packet records whether it was ever an intent to commit.** `SemanticPacket.mode`
is `shadow` or `active`, and reconciliation only repairs `active` packets. This
is load-bearing, not bookkeeping: a shadow deployment's journal is full of
accepted deltas that were deliberately never committed, and a reconciler that
treated every journaled delta as a crash gap would silently promote shadow mode
to active one fold after a restart. That defect was found by the control-arm
evaluation (S1 resolved five of six scenarios when it must resolve none) and is
now pinned by a two-fold shadow test. The schema version was raised 1 → 2 when
the field was added, so a packet written without it is ignored rather than
repaired.

### 3.2 Health states

```
ready         the writer ran, every proposal was accepted and committed
partial       something was refused, unparseable, or failed to persist
unavailable   the writer call itself failed; the checkpoint is deterministic
stale         the journal has accepted deltas the log does not contain
archive-only  no semantic layer is mounted (`semanticContinuity: off`)
```

`archive-only` is reported for `off` — never `ready`. A deployment with no
writer has made no claim about semantic completeness, and saying otherwise would
be the exact overclaim this layer exists to prevent.

A failed semantic write never invalidates the archive. A fold whose writer fails
still publishes its bundle and still lands a deterministic checkpoint.

---

## 4. Rendering: temporal state and a bounded working set

### 4.1 The defect in the old body

Every checkpoint rendered the **entire** current state under a section titled
`Current`. Frozen checkpoints are never rewritten, so after N folds the surface
carried N sections saying `Current`, at different times, with nothing saying
which one won. Measured before the change (two folds, one superseded
constraint):

```
checkpoint 1:  Current   - [constraint …] never commit to main …
checkpoint 2:  Current   - [constraint …] work on the semantic-continuity branch …
```

Both are on the surface simultaneously; the obligation repeated in both.

### 4.2 The new body (active mode)

```
[EF1 L cp:<id>]

Changed in this fold
- [constraint …] …            anchors whose SOURCE EVENTS lie in this fold's span

State from earlier folds (later checkpoints supersede it)
- …                           still-effective state, budgeted
- N more effective item(s) did not fit … use context_search

Rationale
- …                           the writer's handoff
```

`Changed in this fold` is a claim about the **span**, which stays true forever.
The carried section states its own temporality in its heading, so an older
checkpoint cannot be misread as current even though it is never rewritten. Under
`framingMode: system-dedup` the constant system-prompt section additionally says
a later checkpoint is authoritative where two disagree; under `legacy` the
heading carries it (the vendored Basic preamble was **not** modified).

Provenance scoping needs no per-fold side table: an anchor is "changed in this
fold" when at least one of its `sourceRefs` is inside the folded span. That
survives a restart and cannot drift from the log.

**The delta section is capped too** (24 anchors: contracts first, then by
provenance position, then by anchor id — so anchors declared from the same
message tie and fall through to a deterministic but non-chronological order).
A leaf fold touches a bounded span so the cap is rarely reached — but a **root**
fold's span is the whole prefix, which would make "changed in this fold" the
entire state: the unbounded re-rendering this round removes, at the one fold that
is largest. The remainder is not dropped; it flows into the budgeted carried
section, where it is either shown or counted in the `Not shown` pointer. The cap
is asserted by a root-fold test with 60 in-span decisions.

### 4.3 Budget rules

`src/semantic/working-set-compiler.ts`, default 1024 tokens
(`semanticWorkingSetTokens`, 512–2048 is the range this round intends to
measure; the value is a parameter, not a finding).

- **Pinned state is never dropped.** Objective, active constraints, active
  obligations, and unresolved failures are rendered in full. If they alone
  exceed the budget, the body is still larger than the budget and says so
  (`working-set-overflow: pinned state is N tokens against a B-token budget`).
  Trimming a hard constraint to save tokens is the failure mode this layer
  exists to prevent, so correctness wins and the size claim is retracted
  explicitly.
- **Working state is budgeted.** Decisions and findings are added newest-first
  until the budget is reached; the remainder becomes a count plus a
  `context_search` affordance. They stay `active` — not rendered inline is not
  the same as revoked.
- **Nothing is retired by the budget.** Residency and lifecycle are separate.

The compiler prices text with the token meter's `estimateMessage`, the same
pricing Basic uses; a caller without a meter gets a labelled `chars-per-4`
approximation.

---

### 4.4 Degraded rendering keeps the shape

If the writer call fails under `active`, the body is still rendered by
`renderTemporalCheckpoint`, from the post-reconcile state and with no rationale.
Falling back to the legacy renderer would emit an unlabeled `Current` snapshot —
the artifact this mode exists to remove — and freeze it into the log forever.

## 5. Shadow mode

`semanticContinuity: shadow` runs the writer, validates, journals and logs — and
**does not change the model-visible surface**. The body renders through the
pre-existing structured renderer from the pre-fold state; no anchors are
appended; no fold decision reads semantic output.

What shadow deliberately does *not* hold constant: the narrative text itself,
because shadow uses the combined instruction. Paying for a second call in shadow
mode would make the measurement unrepresentative of active mode, and the
rationale slot is model-generated prose either way. This is stated because an
A/B that claims "identical surface except the mechanism" would be wrong.

---

## 6. Why no larger subsystem was introduced

- No vector store, no embeddings, no similarity search. Evidence is an exact
  substring or it is not evidence.
- No knowledge graph. Supersession is a per-coordinate version chain that the
  existing reducer already keeps, bounded at one entry per coordinate.
- No second compaction engine. EF remains the only one; the semantic layer
  writes through the existing anchor service and renders inside the existing
  checkpoint.
- No background/always-on process. One call per fold, inside the fold.
- No new database. The journal is the same atomic-file pattern as the bundle
  store.
- `experience-candidate` is journaled and never anchored: a candidate lesson is
  a weak signal, and promoting one into hot state is the unvalidated authority
  upgrade this layer exists to prevent.

---

## 7. Known limits

1. **Extraction quality is a model property.** The runtime can only refuse bad
   evidence; it cannot make a model notice a subtle constraint. This round
   measures the runtime path, not the model (see `EVALUATION.md`).
2. **One delta per (kind, subjectKey) is "the" value.** A model that picks an
   unstable `subjectKey` for the same thing will create parallel coordinates
   instead of superseding. Nothing here can decide that two keys mean the same
   thing, and guessing from embeddings would be the wrong fix.
3. **Cross-coordinate `supersedes` resolves only within one packet.** A name it
   cannot resolve is recorded and ignored; guessing which coordinate the model
   meant is how a wrong fact gets retired.
4. **`active` mode can make a fold bigger.** If the rendered body exceeds its
   span, Basic's shrink check refuses the fold. The anchors already committed
   remain (they came from still-visible content); the retried fold finds them as
   duplicates and the body shrinks. Observed in the bounded-growth test only
   when 40 pinned constraints were forced into a 512-token budget.
5. **Old checkpoints are never rewritten.** The temporal heading plus the
   framing rule is the mitigation; a root rebase is the only mechanism that
   removes historical snapshots.
6. **The durable-write capability is a HOST property.** `ef/anchor` is outside
   DSH's known event vocabulary; a log containing it is reopenable only when the
   append carried the envelope's `ignorable` marker. EF probes for that
   capability and refuses every anchor write when it is absent (fail closed,
   because the alternative is a session log the read path will not reopen). On
   such a host, `active` commits nothing: every fold reports
   `partial` with a `commit-failed` detail naming the capability error, and the
   checkpoint still archives correctly. The marker is now passed on the WRITE
   as well as the probe — previously only the probe supplied it, so the guard's
   guarantee did not actually cover the writes it gated.
