# RC6 — Prior art: how other DSH context/compaction plugins actually work

Research date 2026-09-30, against the live GitHub ecosystem and the installed
DSH `0.2.0-rc.2`. Method: `gh search code` / `gh api` for repository and file
content, plus direct reads of the sources named below. Nothing here is inferred
from a README alone where the code was reachable.

The purpose is narrow: EF is about to make an integration decision (top-level
replacement vs declared presets, subclass vs copy, opt-in vs default). Other
projects have already made each of those choices, and several have published
their reasoning. This document records what they chose so the decision is made
with the prior art in view rather than re-derived.

## 0. Scale of the ecosystem

Repository counts (GitHub search, `total_count`):

| Query | Repos |
| --- | --- |
| `dsh context plugin` | 237 |
| `dsh memory plugin` | 336 |
| `dsh compaction plugin` | 86 |
| `dsh context compression` | 21 |
| `dsh epistemic` | 2 |

So "context management" is a crowded space, but the subset that **replaces the
compaction engine** — as opposed to storing memory, visualizing context, or
pruning tool output — is roughly a dozen projects. Those are the ones below.

## 1. The four integration strategies, with a real example of each

Every project had to answer "how do I get my engine into the session?" There are
exactly four answers in the wild, and EF currently uses #1.

### (a) Declare your own agent preset — **EF's current choice**

Nobody else in this survey does this. EF's `presets/ef-*.patch.yml` (RC5) is, as
far as this search reaches, the only implementation that ships three of its own
preset rows beside DSH's four. The cost EF pays — extra menu items — is the
reason others avoided it.

### (b) Subclass the host engine, swap the row, restate the preset — **most common**

`overact/dsh-context-management` (v0.3.0) is the closest structural analogue to
EF: it subclasses `BasicCompactionEngine` and overrides `summarize()` and
`compactIfNeeded()`, adding "no separate loop", reusing "native pairing checks,
locks, persistence, and retry logic". Its `scripts/presets.mjs` opens with the
exact finding §10 of doc 29 measured independently:

> The Loader cannot patch rows nested in an agent preset's `config.plugins`
> (only `group: true` lists are indexed) and a patch cannot rename a row, so
> each shipped preset that mounts `@deepseek-ai/dsh-compaction-basic` is
> restated in a generated block of the profile patch with that one row name
> swapped.

It generates that block from the shipped presets, wraps it in
`# >>> context-management preset overrides` markers, refuses to proceed if the
profile already overrides a preset outside its block ("foreign overrides"), and
keeps a `.pre-sync` backup with an atomic rename. It also states the discipline
EF adopted after the RC1.2.1/RC2.1 overclaims:

> No instance monkey-patching, no reads of Cordis internals.

**Relevance to EF:** this is the same preset-restatement EF's §11/§14 arrived at,
including the same reason. It confirms restatement is the accepted community
solution, and it supplies a better engineering pattern for it than EF's current
generator: a marked block plus a foreign-override guard.

### (c) Extend the ABSTRACT `CompactionEngine` and reimplement the transaction

`yoza10635/dsh-argp` (v1.9.1, "dual-engine context compression") does **not**
depend on `dsh-compaction-basic` at all. Its `peerDependencies` list
`dsh-compaction` (the abstract service definition) and it extends
`CompactionEngine` directly, carrying its own transaction code in
`src/prune-tx.ts` and its own `src/preset-cleaner.ts`.

This is the strategy doc 29's §12 assumed was forbidden. It is not — but note
what it costs: `dsh-argp` owns boundary validation, tool-pair balance, surface
replacement, and crash consistency itself. Its README frames the trade
explicitly, and it does *not* claim the fidelity EF claims:

> The fidelity guarantee covers only structured load-bearing tokens verbatim,
> not prose.

**Relevance to EF:** this is the "copy" strategy taken to its conclusion, and it
shows the real price. It also independently confirms §14's isolate finding, and
supplies the *reason* EF only inferred: `src/preset-cleaner.ts` removes the
`isolate:` block from the compaction group because otherwise "cordis creates a
fresh symbol with no fallback to the parent realm, so `command-compact` would
wait forever." EF's §14 established that the naive de-isolation loses the pruner;
`dsh-argp` establishes the converse failure — leaving `isolate:` in place while
removing the rows makes a sibling row hang. Both are the same realm mechanic read
from two directions.

### (d) Vendor a copy of Basic with provenance headers — **exactly the proposal**

`chuxindd/dsh-context-enhancement` is the only project found that does what was
proposed: copy Basic's source into itself. Its `THIRD_PARTY_NOTICES.md` names the
upstream tag and commit and tabulates every copied file:

| Official source | Where used | License |
| --- | --- | --- |
| `dsh-compaction-basic` `src/{config,region,summarizer,types,index}.ts` | `src/internal/compaction/{config,region,summarizer,types}.ts`, `src/compaction-basic.ts` | MIT |
| `dsh-compaction` `src/{tool-pairing,tool-segments,selection-guard}.ts` | `src/internal/compaction/...` | MIT |
| `dsh-compaction-tool-result-pruner` `src/{config,index,types}.ts` | `src/internal/compaction/...`, `src/tool-result-pruner.ts` | MIT |

Its `src/compaction-basic.ts` header states the two properties that matter for
EF's decision:

> It does NOT re-declare `ctx.compaction`: the default-exported class extends the
> official rc1 `CompactionEngine` Service Definition consumed from the published
> `@deepseek-ai/dsh-compaction` package, so the Loader recognizes it as the
> `compaction` service provider.

> compaction-basic and the pruner are mounted in the same preset isolate realm
> and must not have two providers.

**Relevance to EF:** the copy approach is real, MIT-compatible, and has a working
precedent — including the provenance discipline EF would need. It also confirms
that the copy must target the **abstract** `CompactionEngine`, not subclass the
host's Basic, which is a concrete correction to how doc 29 §13 described it.

## 2. What the ecosystem does about the two problems EF is stuck on

### The seam / tier problem

EF's tiers need `frameCheckpoint`, which vanilla DSH lacks, so every tier
refuses to mount (doc 29 §10). No project in this survey depends on a DSH seam.
The copy strategy (d) makes the seam local; the abstract-extension strategy (c)
never needs it because it owns framing outright. **Both escape routes are
already in production elsewhere.** EF is the only project in this set that made
its core capability contingent on a host hook that does not exist.

### The "be Basic" / opt-out problem

Not one project in this survey implements a Basic-compatible mode. The three
engine-replacing projects all treat "run the native engine" as the *absence* of
their plugin — `dsh-context-management` states it plainly:

> Disabling the plugin or its tools falls back to native summaries.

So the community answer to "how do I let the user get Basic back" is: uninstall,
or don't select the preset. EF's proposed internal basic mode has no precedent
here, which is a signal about its cost — nobody who could have built it did.

## 3. What EF uniquely has

Two capabilities appear to be genuinely unoccupied:

1. **A monotonic fold frontier with frozen-prefix identity.** Every other
   engine re-decides its span from scratch each fold. The `[EF1 …]` marker
   protocol and `locateFoldFrontier` are EF-specific; no other project
   distinguishes its own checkpoints from inherited Basic ones.
2. **Byte-exact recall of the archived span as a first-class contract.**
   `dsh-agent-compact` archives the raw span and echoes a spill path
   ("so the model can read the raw text back"); `dsh-argp` recalls structural
   tokens exactly but disclaims prose. EF's `context_recall` returns the
   archived messages themselves. `dsh-context-tree` injects at most 2 KiB per
   checkpoint and "never copies a whole session". So the field converges on
   *some* recall, and EF's is the strictest of them.

Also relevant: `MimicHunterZ/dsh-agent-compact` overlaps EF's *surface* idea
(agent-written checkpoints, span selection, spill archive) but integrates by
**monkey-patching the live engine** — `patchEngine()` reassigns
`engine.summarize` in place and stamps `__ctxcOptimized = 3`. It depends on the
host package as a peer rather than vendoring. That is a fifth strategy EF should
not adopt (it is the instance patching `dsh-context-management` explicitly
renounces), but it is the closest functional competitor.

## 4. What this changes about doc 29's design

| Question | Prior art answer | Effect on EF |
| --- | --- | --- |
| Preset restatement vs own presets | Community restates; EF declares its own | EF's choice is unusual but not wrong — it buys the zero-coexistence property others lack |
| Subclass host Basic vs copy | Copy exists (`dsh-context-enhancement`) and works | §13's copy proposal is validated, with a correction: target abstract `CompactionEngine` |
| Where the seam comes from | Nobody depends on a host seam | EF should own framing, via (c) or (d) |
| Opt-out to Basic | Uninstall / don't select | EF's internal basic mode is unprecedented and its cost is unshared |
| Preset generator quality | Marked block + foreign-override guard + backup | EF's generator should adopt this pattern |

The single most useful correction: **doc 29 §13 described the copy as extending
a local copy of Basic. The precedent (`dsh-context-enhancement`) extends the
abstract `CompactionEngine` and carries the Basic code as internal modules.**
That is the same "copy" but with a cleaner service identity — EF would not
re-declare `ctx.compaction`, and the Loader would recognize it as the compaction
provider without any of the subclass-dispatch problems §12 measured.

## 5. Sources read

- `overact/dsh-context-management` — README, `package.json`, `scripts/presets.mjs`
- `yoza10635/dsh-argp` — README, `package.json`, `src/preset-cleaner.ts`, `src/argp-graph-engine.ts`, `cordis.patch.yml`
- `chuxindd/dsh-context-enhancement` — `THIRD_PARTY_NOTICES.md`, `src/compaction-basic.ts`, `cordis.patch.yml`
- `MimicHunterZ/dsh-agent-compact` — README, `package.json`, `src/optimizer.ts`, `cordis.patch.yml`
- `lifeodyssey/dsh-compressor` — README
- `Tyan66666/billion-context-dsh` — README
- `xiaobright/dsh-anchored-standard` (3.8k★) — `prefab/compaction-epoch.mjs`, `prefab/context-gate.mjs`
- `wr-web/dsh-context-tree`, `pgmi-builds/better-dsh`, `Clearailhc/clearai-dsh` — READMEs
- `bowenliang123/dsh-context` (1.6k★) — README (observability only, does not compact)

## 6. Caveats

- Star counts are from the search API on 2026-09-30 and move fast; the ecosystem
  is only weeks old, so "most projects do X" is a weak signal about correctness
  and a decent signal about what is cheap.
- Repository READMEs were used for *claims*; code was read wherever a claim was
  load-bearing for EF's decision (the four integration strategies, the isolate
  handling, the vendoring). Claims about measured results were not reproduced.
- This survey cannot see private or unindexed plugins.
