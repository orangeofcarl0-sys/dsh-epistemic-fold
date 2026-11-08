# EF-C0 — Convergence Decision

Status: decision, 2026-11-08.

This document answers the seven questions the convergence brief requires. Each
answer cites the artifact that supports it.

## A. Git

**Current SHAs.**

```text
origin/main   93b6666913dab6e00ca67032de9660f1bc75c052
R38 HEAD      006702023e8cf2fcdfd4a814e7be5f2ddf3534ec
merge base    93b6666913dab6e00ca67032de9660f1bc75c052
R38 ahead 96, behind 0
```

Local `main` (`bd1131c`) is a different, older line: 243 behind origin/main and
1 ahead. It is not the released baseline and is not repaired here.

**Ancestry.** The chain `main → rc30 → … → rc38` is unbroken; every stage tip
was verified as an ancestor of the next. RC29 is a side line branched from local
`main`, not an ancestor of R38.

**Commits without a remote ref.**

```text
rc36-semantic-interface      b8274bb
rc37c-measurement-closure    045cccf
rc37d-operational-completion 7a2c974
```

All three are reachable from `origin/rc38-mechanism-validation`; the refs are
missing, the commits are not.

**Branches to keep as research snapshots.** All current `rc*` branches. R38 is
a frozen milestone. No branch was deleted.

**Open PR.** #4, RC29, open since 2026-10-19. Its main artifact
(`src/state/thermal.ts`) is already on `main` via `377515b`. Recommendation:
review and close as superseded if no remaining delta; do not merge blindly.

**New commits this round.** Local only, on `chore/ef-c0-convergence`; see the
handoff for the commit map.

**Push.** Not performed. EF-C0 did not push, merge, rebase, tag or delete.

## B. Product scope

**Stable Core (Track A).**

```text
fold transaction, bundle-before-loss
fold frontier, leaf legality
leaf/root folds, idle rebase, emergency rebase
checkpoint bundle and exact archive
context_search / context_recall
deterministic state projection
task-root protection
system-dedup framing
status / /context / Sidebar
mode: basic stand-down
provider economics profiles
```

**Optional Semantic (Track B).** The writer, validator, authority rules,
journal, commit proof, replay, working set and shadow/active modes. All default
off; all inert under `semanticMode: none`.

**Research-only (Track C).** Task-aware selection, archive recovery, integrity
auditor, recent-tail assessment, context overlay, thermal observer, and the
flagged experiments (referential archive, subagent recall, cross-session
recall).

**Reopened historical non-goals.** Semantic dependency graph, memory
maintenance, cross-session knowledge, LLM-assisted revision and advanced
retrieval are **Deferred**, not permanently closed. They reopen only with a
failure corpus.

**DSH duplication.** None found. EF owns the folding contract and derived state;
DSH keeps goals, plans, instructions, tool execution and the session log.

## C. Configuration

**Real behavior.**

```text
economy    rationale, hint 400, retain 0.16, system-dedup, economic/economics
balanced   rationale, hint 800, retain 0.24
quality    rationale, hint 1600, retain 0.24
legacy     rationale, hint 800, retain 0.16, legacy framing
basic      delegates to Basic, mounts no EF surface
```

**Interaction.** `semanticContinuity != off` requires `semanticMode: rationale`.
The writer shares the rationale call, and the zero-LLM profile must not be
upgraded silently.

**Documentation inconsistency.** `docs/ARCHITECTURE.md` §10 claimed
economy/balanced were `semantic none`. That was true before commit `0376ca3`
(2026-10-18), which changed all tiers to rationale and did not update the doc.
The document now records the current truth and links to the history.

**Zero-LLM baseline.**

```yaml
semanticMode: none
semanticContinuity: off
```

Certified: 0 auxiliary calls, no journal, no packet, no receipt. It is not
"zero model calls in the system"; a fold may still summarize when no projection
is mounted.

**Basic equivalence.** Yes for surfaces and for the success-path checkpoint:
byte-identical body, no EF marker, no bundle, no tools, no anchor service, no
status projection. The engine still owns `ctx.compaction` — that is how it
delegates.

## D. Architecture

**Minimal interface.** The engine extends Basic and overrides five points
(`compactRegion`, `compactIfNeeded`, `compactNow`, `summarize`,
`frameCheckpoint`), each with an `isBasic()` early return. The semantic
acquisition block sits inside `summarize`, guarded by continuity and by the
presence of a mounted projection.

**Semantic failure fallback.** Safe. A writer error is caught; the fold
publishes a deterministic body and the archive is intact. A refused delta does
not prevent exact recall. The tests are C2 and C7.

**Coupling debt.** `engine.ts` is 3,716 lines; the semantic branch is ~1,000 of
them. A split is **not** performed: the boundary is testable through config and
failure injection, so the brief's "extract only when isolation fails" condition
is not met.

**Does it need a package split?** No. The optional layer is inert when off; a
package split would add distribution complexity without a failing test.

**Research modules without a production path.**

```text
src/state/thermal.ts        no import outside its test
eval/r38/src/*              eval only
eval/memory, eval/tau2      eval only
```

The thermal observer is the notable one: it lives under `src/` but does not
ship. Moving it is a future refactor, recorded not done.

## E. Evidence

**RC1.3 quality parity.** Applies to `economy` with `semanticMode: none`, n=9,
one probe shape. It does **not** transfer to today's economy tier, which makes a
rationale call.

**Economy cost advantage.** `0.00166` vs `0.02778` per run on n=5, about 17×.
Provider/price are **Unknown** in the source; auxiliary calls are zero; cache
effects are not separated. It is a real observation for that sample, not a
stable property.

**Why the cost gate is open.** Dispersion (n=8), one task shape, price-list
dependence, and no frozen cost ledger. A closed gate needs a frozen task set,
route, price list and per-arm ledger.

**What R37's Active negative difference supports.** Under
`deepseek-v4.1-flash` / local omnigate2api / P3e, across 36 pairs, Active did
not improve contract success: 9 damage vs 1 rescue. It does not support a
universal harm claim, and its comparison arm B1 is **not** Native DSH Basic.

**Why R38's mechanism gains are not product gains.** R38 made 0 live calls.
Its results are deterministic or fixture-level. A selector that picks the right
fixture anchor has not been shown to improve a real run.

## F. Governance

**How the product line promotes a capability.**

```text
Research → Mechanism Certified → Product Candidate → Stable
```

Each step needs its own evidence; mechanism certification is not a product
claim.

**How the research line keeps history.** Frozen branches, SHA registry entries,
and immutable evidence. Research commits are never rebased once shared.

**Why not merge R38 into main.** It would carry 96 research commits, Track C
eval code and generated evidence into the product history. `main` does not even
contain `src/semantic/`; a merge would import the whole layer, not a fix.

**Tag vs branch.** Tag a release artifact; use a SHA for a research stage. Do
not tag every round.

**CI and release gates.** Proposed: Core Gate, Semantic Gate, Research Gate,
Compatibility Gate. CI currently triggers on `main` pushes and any PR, and its
vendor tree is 0.2.0-rc.2 while devDependencies are 0.2.1-rc.3.

**Preventing scope creep.** The charter's change discipline, the scope matrix's
five states, and the rule that a research module existing is not evidence that
it ships.

## G. Next research

**Next product hypothesis.** M1: on a frozen long-horizon task set, does today's
`economy` (with its rationale call) preserve Basic's facts at a lower total
cost? This is the cheapest path to a product-level claim and it protects the
core.

**Next semantic question.** M2: split user decision authority from assistant
decision authority, using event provenance rather than text inference. This is
the remaining safety hole.

**Can they proceed independently?** Yes. M1 is Track A and needs no semantic
layer. M2 is Track B and needs no product integration.

**Should R38-M1 stay paused?** Yes. It mixes too many variables, has no frozen
manifest for execution, and R37-B already produced a negative Active result.
A new manifest must supersede it.

**How complex semantics evolve without dragging the core.** Keep Track B/C on
the research line, default off, with the C1–C7 contracts; promote one variable
at a time through the five-step integration path.

## Decision

```text
EF Active: deployment hold
deploymentEligible: false
Product path: Track A on main
Research path: R38 line, open
Convergence: complete
```
