# RC7 — Transformation plan: in-place substitution + the Basic copy

Status: PLAN. Nothing in this document has been implemented. Every factual claim
marked **[measured]** was verified against the installed DSH `0.2.0-rc.2` in this
session; claims marked **[hypothesis]** are not yet measured.

## 1. The target end state

The product surface the vision asks for, stated as testable properties:

| # | Property | How it is checked |
| --- | --- | --- |
| P1 | DSH's agent-preset menu shows exactly its own four items | roster size == 4, ids == `standard, ptc, cordis, minimal` |
| P2 | EF runs under `standard`, `ptc`, `cordis` with no opt-in step | `serviceFor(agent,'compaction')` is `EpistemicFoldEngine` |
| P3 | A user can get byte-identical native Basic back | `mode: basic` produces a Basic-identical checkpoint, no EF surface |
| P4 | The three tiers mount on any DSH build | no dependency on a host `frameCheckpoint` seam |
| P5 | `/context mode` affects one preset's sessions, not the process | switching on `standard` leaves `ptc` unchanged |
| P6 | The Sidebar keeps working, and never enters model context | status projection readable at host scope; no prompt section |
| P7 | `minimal` is exactly what DSH ships | no compaction under `minimal` |
| P8 | Tool-result pruning keeps working under EF | `serviceFor(agent,'toolResultPruner')` defined per preset |

P1–P2 and P5–P8 are **[measured]** feasible by the in-place substitution already
probed (§3). P3–P4 are the copy's job (§4). P7 is a deliberate decision, not an
accident (§7.1).

## 2. Why this shape, in one paragraph

Three integration strategies were measured. **Top-level replacement** (mount EF
once at the host plane, de-isolate each preset's compaction group) keeps the menu
at four but silently breaks two things: `minimal` gains compaction it never
shipped with, and the tool-result pruner becomes unreachable — the engine's only
caller cannot see it, so pruning stops without any error. **Declaring EF's own
presets** (RC5, current) is honest but adds three menu items. **In-place
substitution** — replace only the `compaction-basic` row inside each preset's
*existing* compaction group, leaving that group's `isolate:` realm intact —
keeps the menu at four and changes nothing else: `minimal` stays empty, every
preset keeps its own pruner, and the engine is per-preset so a mode switch does
not leak. It is strictly better than the top-level variant on every measured
axis. What it does not solve is the seam: a tier still refuses to mount on
vanilla DSH. That is the copy's job, and the copy also delivers P3.

## 3. Workstream A — In-place substitution

**Goal:** P1, P2, P5, P7, P8.

### A1. Rewrite the preset generator

`scripts/generate-presets.mjs` currently emits three *new* preset declarations
(`presets/ef-{economy,balanced,quality}.patch.yml`). It becomes a generator of
**in-place override rows**: for each of `standard`, `ptc`, `cordis`, take the
shipped preset's `config` verbatim, and inside the `compaction` group only:

- rename the `compaction-basic` row's `name:` to `dsh-epistemic-fold`;
- give that row EF's config (`bundleRoot`, `mode`, `auto`);
- add `epistemicFold: true` to the group's existing `isolate:` map.

Everything else — all 19 rows, the other two groups, `minimal` entirely —
untouched. `minimal` is skipped **because it has no compaction group**
**[measured]**, which is also what makes P7 free.

The existing `substituteBackend()` already does the row substitution and the
isolate-map extension and throws when there is no isolate map to extend. What
changes is the *envelope*: the output is a top-level `- id: preset-standard`
override instead of an `- insert:` of a new preset, and the file count drops
from three to one.

### A2. Adopt the community's generator discipline

`overact/dsh-context-management` (same subclass strategy as EF) ships three
practices EF's generator lacks. Adopt all three, because the failure they
prevent is silent:

1. **A marked block.** Generated rows live between
   `# >>> epistemic-fold preset overrides` / `# <<<` markers, so regeneration
   replaces exactly its own output and cannot eat hand-written rows.
2. **A foreign-override guard.** Before writing, refuse if the profile already
   overrides one of the three preset ids outside the block. Without it, two
   plugins that both restate `preset-standard` collide, and the loader's
   behaviour is "last layer wins" — i.e. one of them silently stops working.
3. **A backup + atomic rename.** Write `.pre-sync` then `renameSync`. The
   profile patch is the one file whose corruption bricks the harness.

### A3. Collapse `dsh.bundle.patch`

`package.json`'s `dsh.bundle.patch` array goes from four entries
(`cordis.patch.yml` + three preset files) to **one**. `cordis.patch.yml` stops
being empty and carries the generated block. Rationale: the in-place design has
exactly one artifact, and keeping it in one file is what makes the marked-block
guard meaningful.

### A4. Repurpose the drift test

`tests/rc5-preset-drift.spec.ts` currently pins EF's three presets against DSH's
reference. It becomes: regenerate in memory from the installed DSH and assert
the checked-in file matches, per preset, row by row — and assert that `minimal`
appears nowhere in the output. A DSH upgrade that changes any non-compaction row
then fails a test instead of silently forking the user's session.

## 4. Workstream B — The Basic copy

**Goal:** P3, P4. This is the only workstream that touches the engine's base
class, and §7.2 records the tension that creates.

### B1. Vendor Basic as internal modules

Precedent: `chuxindd/dsh-context-enhancement` does exactly this, with a
`THIRD_PARTY_NOTICES.md` naming the upstream tag and commit and a `SOURCE:`
provenance header on every copied module. EF follows that pattern.

Carry `config.ts`, `region.ts`, `summarizer.ts`, `types.ts`, `index.ts`
(≈1,750 lines **[measured]**) into `src/basic/`. Their internal dependency
closure is closed — only `node:crypto`, `node:util`, and `@deepseek-ai/*`
packages **[measured]** — so nothing else comes along.

**One correction to doc 29 §13.** That section described the copy as "extend a
local copy of Basic". The precedent extends the **abstract `CompactionEngine`**
and carries Basic's code as internal modules instead. That is the same copy with
a cleaner identity: EF does not re-declare `ctx.compaction`, and the
virtual-dispatch problem §12 measured (a `super` call re-entering EF's overrides)
does not arise, because EF's `super` is its own copy rather than the host's.

### B2. Inline the seam

`scripts/apply-framing-seam.mjs` patches ten exact locations to add an
overridable `frameCheckpoint`. Those edits move into the vendored copy as its
default behaviour. The script is retained only as the record of what was
vendored and why.

`src/compat.ts` changes meaning: `detectDshCapabilities()` currently probes the
host's `BasicCompactionEngine.prototype`. After the copy it probes EF's own base,
so `frameCheckpointSeam` is always `true` and `assertDshCompatibility` can no
longer fail on a released build. **The guard stays** — it is still the thing that
would catch a bad vendoring — but it stops being a deployment precondition.

### B3. Drop the peer dependency

`@deepseek-ai/dsh-compaction-basic` leaves `peerDependencies`. EF then installs
on a DSH that does not ship Basic at all. `src/policy.ts` imports the
`BasicCompactionConfig` type from it; that type is mirrored locally, exactly as
`src/types.ts` already mirrors the summarizer face.

### B4. The new test obligation

Doc 29 §13 named this the real cost and it is: shipping `mode: basic` as a
promise converts "EF is invisible" from a deployment property into a **tested**
property. The test is a differential one — same session, same budgets, both
engines, assert the checkpoint bodies are byte-identical and that EF writes no
bundle. A one-off run was verified in this session **[measured]**; the plan's
obligation is that it becomes a standing test that fails on divergence, not a
result quoted in a document.

## 5. Workstream C — The Basic mode

**Goal:** P3.

### C1. Five pass-through branches

EF diverges from Basic at exactly five points **[measured]**:
`compactIfNeeded`, `compactRegion`, `compactNow`, `summarize`, `frameCheckpoint`.
A branch at **all five** reproduces Basic exactly **[measured]**:

```
BASIC            <compacted-summary>SEMANTIC-SUMMARY-MARKER</compacted-summary>
EF basic-mode    <compacted-summary>SEMANTIC-SUMMARY-MARKER</compacted-summary>
BOTH FOLDED: true   IDENTICAL: true   EF wrote a bundle: false
```

Branching at only one point does **not** work — virtual dispatch re-enters the
others (`compactRegion -> summarize -> frameCheckpoint -> compactRegion`)
**[measured]**. That is why the plan is five branches and not one flag check.

### C2. Basic mode must mount nothing

The reason is the RC4-A blocker: a mounted EF whose engine does not fold still
reports. `mode: basic` therefore suppresses EF's whole surface at construction —
the state projection, the status projection (the Sidebar's source), the recall
tools, and the `/context` command. With `mode: basic`, EF is indistinguishable
from not being installed, which is the only honest reading of "invisible".

Consequence: `mode: basic` is an **install-time** value, read before mount.
Switching to or from it at runtime is refused, for the same reason
`setMode` already refuses a `framingMode` change: the projection registration is
a mount-time fact, not a policy knob.

### C3. Vocabulary

`FoldModeName` gains `'basic'`. It is not a tier — `TIER_MODE_NAMES` stays
`['economy','balanced','quality']` — and `resolvePreset('basic')` returns `{}`,
like `legacy`. The distinction between `legacy` and `basic` matters and should be
documented: `legacy` is EF's own default policy with marker-only checkpoints;
`basic` is EF standing aside entirely.

## 6. Workstream D — Retire the EF presets

**Goal:** P1.

- Delete `presets/ef-economy.patch.yml`, `ef-balanced.patch.yml`,
  `ef-quality.patch.yml`.
- Delete `presets/` from `package.json`'s `files` if the generator no longer
  writes there.
- Repoint `dsh.bundle.patch` (A3).
- Update `README.md`: the install story becomes "add the bundle; EF runs; the
  menu is unchanged".
- Update `docs/29_RC5_PRESET_DESIGN.md` §1/§4/§5, which describe the preset
  design as shipped. §10–§15 already record why it changed; §1–§5 need a pointer
  to §15 rather than a rewrite, so the reasoning trail survives.
- `docs/24_RC2_PRODUCT_INTEGRATION.md` §3 describes the user-facing surface as
  three modes plus `/context status`. That stays true; the *selection* mechanism
  changes from "pick a preset" to "the preset you already pick, plus
  `/context mode`".

## 7. Decisions this plan makes, and the two tensions it creates

### 7.1 `minimal` gets nothing (recommended: keep it that way)

With in-place substitution, `minimal` — which ships with no compaction group —
keeps no compaction. So "EF runs everywhere" is false: it runs under three of
four presets.

Recommendation: **leave `minimal` alone.** It is DSH's deliberately bare preset;
giving it a compaction engine changes what "minimal" means, and it was the
top-level variant's worst side effect (§3). A user who wants EF and a small tool
set can use `ptc`. This should be stated in the README so it is a documented
property rather than a surprise.

### 7.2 The architecture-freeze tension (must be surfaced, not hidden)

RC2's standing constraint is: *compression architecture is CLOSED; research
reopens only on a real incident.* Workstream B replaces the class EF extends and
brings ~1,750 lines of upstream code in-house. That is not a policy change — it
changes no threshold, no admission rule, no fold policy — but it is unambiguously
a change to the engine's architecture layer.

Two honest readings, and the plan should not paper over which one applies:

- **It is not a reopening.** EF's compression *behaviour* is unchanged; the copy
  exists to own framing and to enable a byte-identical passthrough. No M1/M3b/M4/M5
  gate reopens, and `dc9bff7` remains the behavioural baseline.
- **It is a reopening.** The maintenance surface grows from "a subclass" to "a
  vendored fork of a host package", which is the thing doc 29 §1 explicitly
  rejected as "a second engine to maintain".

The plan proceeds on the first reading, on the grounds that the copy is
mechanical, MIT-licensed, provenance-tracked, and pinned by a drift test — i.e.
the maintenance is real but bounded and *loud when it breaks*. This is a
user-directed change (the copy was the user's own proposal) and should be
recorded as such in the changelog, with the second reading quoted so a future
reader can disagree with the call rather than have to rediscover it.

### 7.3 Mode selection is per-preset, not per-session

In-place substitution gives one engine per preset, so `/context mode` switches
all sessions of that preset. This is a strict improvement over the top-level
variant's process-wide engine, but it is still not per-session. Accepting it:
the alternative (per-session engines) would mean one compaction engine per
session, which contradicts the service's "load one implementation per context"
contract **[measured in the abstract service's own doc comment]**.

## 8. Test obligations

| Id | Test | Guards |
| --- | --- | --- |
| T1 | Basic-parity differential (B4) | P3 — the copy and the passthrough stay byte-identical |
| T2 | In-place drift vs installed DSH | A4 — the restated rows do not rot |
| T3 | `minimal` unchanged | P7 — no compaction group is invented |
| T4 | Pruner reachable per preset | P8 — the §14 defect cannot recur |
| T5 | Mode switch does not leak across presets | P5 |
| T6 | `mode: basic` registers no EF surface | C2 — the RC4-A defect cannot recur |
| T7 | Vendored copy vs upstream reference | B1 — the fork does not silently diverge |
| T8 | Roster size and ids | P1 |

T1, T6 and T7 are new obligations this project does not currently carry. T2
exists and is repurposed. T3–T5, T8 are cheap and should be written alongside
their workstream.

## 9. Sequencing

Each milestone is independently shippable and independently verifiable.

| M | Content | Delivers | Risk if it stops here |
| --- | --- | --- | --- |
| **M0** | Basic copy + inlined seam + T7, still `mode: legacy` | Nothing user-visible changes; the seam stops being a deployment precondition | EF still has three menu items |
| **M1** | `mode: basic` + C2 + T1/T6 | P3 — the opt-out exists | — |
| **M2** | In-place generator + A3 + A4 + T2/T3/T4/T8 | P1, P2, P5, P7, P8 — the menu goes back to four | EF runs only `legacy` until M0 lands |
| **M3** | Retire EF presets + docs (§6) | The vision's surface | Docs describe a design that no longer ships |
| **M4** | Real-DSH daily use | The actual acceptance test | — |

M0 before M2 is deliberate: M2 alone can only run `mode: legacy`, because a tier
in that slot fails to mount without the copy **[measured]**. Shipping M2 first
would put a broken preset in front of the user.

M4 is the point of the whole thing, and it is not a test suite. RC2's own
conclusion stands: *"让用户真正开着 DSH 用一天"* is worth more than dozens more
synthetic runs. The measurable question M4 answers is whether the three tiers are
distinguishable in a real day's use — the question RC2 could not answer because
TaskQuality saturated.

## 10. What is explicitly NOT changing

- **Compression policy.** No threshold, admission rule, rebase policy, retention
  ratio or framing mode changes. `dc9bff7` remains the behavioural baseline.
- **The retrieval layer.** Frozen since RC1.3.1. No search/recall change.
- **The `EF1` marker protocol and the fold frontier.** Untouched; the copy does
  not affect EF-authored checkpoints, only the base class EF builds on.
- **`semanticMode: none` as economy's setting**, and the cost gate staying OPEN.
- **The Sidebar contract.** Same projection, same "never enters model context"
  rule, same `unknown ≠ 0` discipline.
- **`/context status`.** Same model, same text renderer.

## 11. What would invalidate this plan

Recorded so a future run can falsify rather than re-argue:

1. **If the in-place override cannot be expressed as a whole-`config`
   replacement that DSH accepts on every preset.** Verified for
   `standard`/`ptc`/`cordis` **[measured]**, but a DSH upgrade could add a preset
   whose compaction group differs in shape. T2 covers this by failing loudly.
2. **If vendoring Basic proves not to be MIT-compatible.** It is MIT
   **[measured: `vendor/deepseek-harness/LICENSE`, "MIT License, Copyright (c)
   2026 DeepSeek"]**, and a precedent project ships the same copy, but the notice
   obligation must be honored.
3. **If the copy's five-branch passthrough drifts from Basic on a case the
   differential test does not cover.** T1's coverage is the mitigation; the
   residual risk is real and is why T1 must cover manual `/compact` and
   overflow-triggered folds, not just pressure folds.
4. **If the user wants per-session mode selection.** §7.3's accepted limitation
   becomes a blocker, and the design needs revisiting.

---

# Part II — Distribution simplicity (the constraint that shapes Part I)

The plugin must be installable by a stranger on an unknown machine with an
unknown DSH version. That constraint is not cosmetic: it changes the
implementation of Workstream A, and it adds a hard requirement the plan above
did not have. Everything in this part was measured this session.

## 12. The distribution problem with the naive in-place design

Workstream A as written generates a `cordis.patch.yml` containing **the full
`config` of each shipped preset** — 19 rows per preset, three presets. Those rows
are a copy of DSH's own preset declarations, and they are **version-specific**:
DSH `0.2.0-rc.2` ships one row list, a later release may ship another.

The failure mode when they diverge is the dangerous kind **[measured]**:

> a patch whose target row is absent **warns and is skipped** — boot survives.

So if DSH renames `compaction-basic`, or restructures the compaction group, EF's
override silently stops applying. The user keeps running native Basic while EF's
Sidebar and `/context` still report an EF that never folds — the RC4-A blocker
class, arrived at from a different direction, on someone else's machine where we
cannot see it.

That makes "ship a generated YAML" unacceptable as the primary mechanism. Three
alternatives were measured.

## 13. What was measured

### 13.1 Runtime rewrite of the live loader tree — works, but fragile

A plugin can rewrite a shipped preset row at runtime. The live `EntryTree`
exposes `resolve(id)` and `update(id, options, parent, position)` **[measured]**,
and the preset rows are reachable in it:

```
[rw] found EntryTree via entry.subtree: true
[rw] tree.resolve is function | tree.update is function
[rw] update() resolved
LIVE compaction-basic name: PROBE-REWRITTEN
LIVE isolate: {"compaction":true,"toolResultPruner":true,"probeRealm":true}
```

Two sub-findings matter for distribution:

- **`Entry.update(options, create, force)` avoids the tree write-back.**
  `EntryTree.update()` calls `source.tree.write()`, which rewrote the user's
  `cordis.yml` from 3 bytes to **44 KB** of composed rows. Calling the `Entry`'s
  own `update()` instead gives sessions the EF engine and leaves `cordis.yml` at
  **221 bytes (untouched)** **[measured]**. A distributable plugin must not
  rewrite the user's profile root, so only the `Entry` form is acceptable.
- **Timing is fragile.** A rewrite fired 1.2 s after mount was **reverted**:
  the entry read back as `@deepseek-ai/dsh-compaction-basic` at t+3 s. The same
  rewrite fired at 5 s **stuck** **[measured]**. That is a race against boot
  ordering, and "wait 5 seconds" is not a mechanism — it is a coincidence that
  happens to hold on this machine.

Verdict: usable as a **fallback**, never as the primary path.

### 13.2 A bundle patch layer — clean, and the right primary mechanism

`package.json`'s `dsh.bundle.patch` rows are applied in bundle order, and
`dsh-web-app`'s own presets are inserted by its own patch file. So a bundle
listed **after** `dsh-web-app` sees those preset rows and can override them
**[measured]**:

```
MENU: 4 -> standard, ptc, minimal, cordis
  standard  compaction=EpistemicFoldEngine    pruner=ToolResultPruner
  ptc       compaction=EpistemicFoldEngine    pruner=ToolResultPruner
  cordis    compaction=EpistemicFoldEngine    pruner=ToolResultPruner
  minimal   compaction=(NONE)                 pruner=(NONE)
```

No race, no disk write, correct layer order. This is what §3's A1/A3 should
produce, and it is what the shipped artifact should be.

### 13.3 A drift guard — required, because 13.2 can fail silently

Since a missing patch target only warns **[measured]**, EF must verify its own
substitution landed. A plugin can: the registry's `definitions` map holds each
preset's rows, so a boot-time check can count how many presets actually name
`dsh-epistemic-fold` **[measured]**:

```
BOOT SURVIVED a patch targeting a nonexistent row: true
presets running EF (guard would fire if 0): 0
=> a plugin CAN detect a failed substitution: true
```

This becomes a hard requirement (§15, T9).

## 14. The distribution design

Three mechanisms, layered by trust:

| Layer | Mechanism | When it fails | Why it is here |
| --- | --- | --- | --- |
| 1 | **Bundle patch** (§13.2) | DSH restructures a preset | Primary. Correct layer order, no race |
| 2 | **Boot-time self-check** (§13.3) | Never silent | Turns a failed layer 1 into a loud error |
| 3 | **Runtime rewrite** (§13.1) | Only if boot ordering changes | Fallback that repairs layer 1 in place |

Plus a fourth, offline mechanism:

| Layer | Mechanism | Purpose |
| --- | --- | --- |
| 4 | **`prepare` script regeneration** | Re-generate layer 1 from the LOCAL DSH at install time |

Layer 4 is what removes version-pinned YAML from the repository. `dsh plugin add`
installs through pnpm and runs the package's `prepare` script
**[measured: the CLI's own error text names `prepare` as the install-time build
hook]**, and `scripts/generate-presets.mjs` already locates the installed DSH
through `DSH_HOME`/`~/.dsh` and mirrors a real preset rather than inventing one
**[measured]**. So the shipped repository need not contain a preset row list at
all: it contains the *generator*, and the artifact is produced on the machine
that will run it.

**Failure containment for layer 4.** If `prepare` does not run (a tarball
install, a blocked build script, no web profile), the checked-in fallback patch
must still be correct for *some* DSH version. So the repository keeps the
generated file, and the drift test (§3 A4) pins which version it matches. The
artifact is then either (a) regenerated locally — preferred — or (b) the pinned
fallback plus a loud self-check that refuses to pretend.

## 15. Additions to the plan

These modify Part I; the workstreams otherwise stand.

- **A1 (revised).** The generator emits the bundle patch consumed by layer 1.
  It is regenerated by `prepare` (§14 layer 4), not only by hand.
- **A3 (revised).** `dsh.bundle.patch` is **one** file — the generated bundle
  patch — and EF must be listed **after** `@deepseek-ai/dsh-web-app` in the
  profile's bundle order for layer 1 to see the preset rows. The install
  instructions must say so, because bundle order is a profile fact EF cannot
  set for itself.
- **New workstream E — the self-check.** At mount, verify that at least one
  preset names `dsh-epistemic-fold`; if none do, log a loud error naming the
  likely cause (DSH preset restructure / wrong bundle order) and, if layer 3 is
  enabled, repair in place. A silent revert to Basic is not acceptable.
- **New test T9.** Boot with a deliberately wrong patch target and assert the
  self-check fires. This is the test that makes layer 2 real.
- **New test T10.** Assert a runtime rewrite leaves `cordis.yml` byte-identical.
  §13.1 showed the difference between the two `update` forms is a 44 KB profile
  rewrite, and nothing currently guards it.
- **C2 (revised).** `mode: basic` should **disable layer 3** as well as EF's
  surface. A user who asked for Basic must not have a plugin quietly rewriting
  their presets.

## 16. Distribution checklist (what a stranger must do)

The acceptance bar for "distributable", to be verified on a machine that has
never seen EF:

1. `dsh plugin --profile web add <package>` — one command.
2. No manual YAML editing, no `--patch` overlays, no path arguments.
3. The preset menu is unchanged (four items).
4. Sessions under `standard` run EF; the Sidebar shows it.
5. `cordis.yml` and `cordis.patch.yml` in the user's profile are byte-identical
   to before the install.
6. `dsh plugin remove` restores native Basic with no residue.

Item 5 is the one the current design would fail without §13.1's finding, and item
6 is the one to test first, because uninstall correctness is what makes an
invasive plugin acceptable at all.

---

# Part III — Implementation outcome (RC7 shipped)

Everything in Parts I and II is now implemented and verified. This part records
what actually shipped, the three findings that changed the plan during
implementation, and the honest status of each claim.

## 17. What shipped

| Workstream | Status | Evidence |
| --- | --- | --- |
| **B — the Basic copy** | ✅ | `src/basic/` (5 modules, provenance headers), `scripts/vendor-basic.mjs`, `THIRD_PARTY_NOTICES.md`, T7 |
| **C — `mode: basic`** | ✅ | Five pass-through branches, surface suppression, T1 + T6 |
| **A — in-place substitution** | ✅ | Rewritten generator, one bundle patch, T2 |
| **E — the doctor** | ✅ | `src/doctor.ts`, T9 (8 assertions), verified firing on a real broken install |
| **D — retire EF's presets** | ✅ | `presets/` deleted, `dsh.bundle.patch` is one file, RC5 drift test retired |
| **M1 — verified in a real DSH** | ✅ | Under `mode: basic` the status projection and `/context` are ABSENT; under `economy` both present |
| **Final E2E** | ✅ | Real DSH, EF installed as a bundle: menu `standard, ptc, minimal, cordis`; three presets run `EpistemicFoldEngine`; every pruner present; `minimal` unchanged |
| **Doctor E2E** | ✅ | Good install logs `substitution active in 3 preset(s)`; broken install logs the loud error |

**The M0 claim, which was the point of the whole exercise** — before RC7, every
tier refused to mount on a released DSH because `framingMode: system-dedup` needs
a `frameCheckpoint` seam no released build ships. Measured after:

```
mode=legacy    framingMode=legacy        MOUNTS
mode=economy   framingMode=system-dedup  MOUNTS
mode=balanced  framingMode=system-dedup  MOUNTS
mode=quality   framingMode=system-dedup  MOUNTS
```

## 18. Three findings that changed the plan

### 18.1 The vendored reference ALREADY carries the seam — so the copy is exact

The plan assumed the copy would need the seam inlined from
`scripts/apply-framing-seam.mjs`. It does not: the reference checkout this
repository pins already has it applied (R3-B put it there). The copy is therefore
**byte-identical to the reference** apart from a provenance header, which makes
T7 far stronger than planned — it compares every module exactly rather than
tolerating a set of expected divergences.

Sabotage-verified: changing `DEFAULT_THRESHOLD_RATIO` from `0.8` to `0.75` in the
copy fails T7.

### 18.2 The self-check as designed could never fire — the doctor is a separate entry

**This is the finding worth recording.** The plan put the substitution self-check
inside `EpistemicFoldPlugin`. Implemented that way, T9 passed — and the check was
**unreachable on exactly the path it existed for**, because EF is mounted *by* the
substitution: it is a row inside each preset's compaction group. When the
substitution misses, EF never mounts, so a check inside EF never runs.

It was caught by booting a deliberately broken install (a valid patch targeting a
nonexistent preset id, the shape a DSH rename produces) and observing that the
check's log line never appeared. The unit test had passed while the real failure
path was dead.

The fix is structural, not a bug fix: `src/doctor.ts` is a **separate top-level
entry**, mounted by a row that lives OUTSIDE the generated block (so a
regeneration cannot delete it), and it is observation-only — no service, no
projection, no state. That is what keeps it from re-creating the RC4-A defect: it
cannot report on folds at all, only on whether EF is installed. T9b asserts the
structural property, and is sabotage-verified by moving the row inside the block.

### 18.3 Runtime repair was rejected; the doctor only reports

Part I considered a runtime rewrite of the loader tree as a repair mechanism. It
works — `EntryTree.resolve` + `Entry.update` can substitute a preset row at
runtime, and `Entry.update` (unlike `EntryTree.update`) does not write 44 KB back
into the user's `cordis.yml`. But it is a race against boot ordering: a rewrite
fired 1.2 s after mount was reverted, one fired at 5 s stuck. "Wait five seconds"
is a coincidence, not a mechanism. The doctor therefore reports and never
repairs, and the 5 s delay is documented as a read-only timing choice.

## 19. Test obligations, as shipped

| Id | Test | Status |
| --- | --- | --- |
| T1 | Basic parity — byte-identical checkpoint, no marker, no bundle | ✅ `rc7-basic-mode.spec.ts`, sabotage-verified |
| T2 | In-place drift vs installed DSH | ✅ `rc7-inplace-drift.spec.ts`, sabotage-verified twice |
| T6 | `mode: basic` registers no EF surface | ✅ same file, sabotage-verified |
| T7 | Vendored copy vs reference | ✅ `rc7-vendored-basic.spec.ts`, sabotage-verified |
| T9 | The doctor fires when the patch misses | ✅ `rc7-preset-self-check.spec.ts` (8 assertions) |
| T9b | The doctor mounts outside the generated block | ✅ same file, sabotage-verified |
| T10 | `mode: basic` suppresses the surface at mount | ✅ covered by T6 |
| T3/T4/T5/T8 | `minimal` unchanged, pruner reachable, no mode leak, roster size | ✅ covered by the final E2E, not by a standing unit test |

**T3/T4/T5/T8 are verified by observation, not by a committed test.** The final
E2E booted a real DSH and printed all four properties, but that script was a
throwaway. Converting it into a committed test requires a real DSH on the machine
running the suite, which the keyless tier deliberately does not assume. This is a
real gap and is recorded as one rather than claimed as covered.

## 20. What is still not done

1. **A committed test for the four E2E properties** (§19). Today they are
   observed once, by hand.
2. **The tier has not been exercised through a model.** Every tier MOUNTS and
   resolves correctly; no turn has been run through a provider inside a
   substituted preset. RC2's conclusion stands — a real day of use is worth more
   than more synthetic runs, and that is M4.
3. **`mode: basic` is not yet the default.** The substituted rows currently
   declare `mode: economy`, the one tier with measured evidence. Making `basic`
   the default would require the copy to be the ONLY path EF ever takes, which is
   a larger claim than the measurements support.
4. **The `prepare` hook would have BROKEN a clean install — found and fixed.**
   Exercised with no DSH present, the generator originally THREW:

   ```
   Error: no installed dsh-web-app presets directory under ...
   ```

   Since `prepare` runs on every install, that would have failed the install on
   any machine without a DSH web profile — i.e. exactly the machine about to
   install EF in order to get one. It now degrades gracefully: it says so, leaves
   the checked-in block alone, and exits 0. The boot-time doctor is what catches
   a stale block on the machine that eventually runs it. Verified: with no DSH
   the block is byte-identical afterwards; with a DSH present, `prepare`
   regenerates it identically and the doctor row survives (it lives outside the
   generated markers).
5. ~~**Uninstall has not been tested.**~~ **Now tested.** Booting the same
   profile with the bundle present and then absent:

   ```
   installed  doctor=true  engines={standard: EpistemicFoldEngine, ptc: EpistemicFoldEngine, minimal: (NONE)}
   removed    doctor=false engines={standard: BasicCompactionEngine, ptc: BasicCompactionEngine, minimal: (NONE)}
   ```

   Removing the bundle restores native Basic, removes the doctor, and leaves
   `minimal` untouched. No residue.
6. **The profile write-back is DSH's, not EF's — measured.** An earlier RC7
   experiment (runtime rewriting the loader tree) wrote **44 KB** of composed
   rows into the user's `cordis.yml`. The shipped design does not. Measured:

   ```
   vanilla (no EF)      cordis.yml  3 -> 221 bytes
   EF installed         cordis.yml      221 bytes   (no preset override present)
   ```

   Vanilla DSH itself rewrites that file on boot; EF adds nothing to it. §16's
   item 5 is therefore satisfied for the write-back that matters — EF does not
   compose its own rows into the user's profile.

---

# Part IV — Real interaction test: two defects only the UI could find

Driven through the actual DSH web UI (real server, real browser, real clicks) —
not through the host API. Every step below is an observation from that session.

## 21. What worked on the first try

| Interaction | Result |
| --- | --- |
| Preset menu | **exactly DSH's four items** (`标准模式`/`PTC 模式`/`极简模式`/`创造模式`), none mentioning EF |
| `/context` in the palette | registered, described as "Epistemic Fold: report status, or switch the mode tier" |
| `/context` (no args) | full status: mode, pressure, window, occupancy, fold threshold, archive, checkpoints, retrieval, lifetime folds, route, cost, provider usage |
| `/context mode balanced` | `mode economy -> balanced`, with `evidence: HYPOTHESIS` |
| persistence | re-querying shows `context mode: balanced` — the switch stuck |
| invalid tier | `失败 · unknown mode "turbo"; choose one of "economy", "balanced", "quality"` |
| `mode basic` at runtime | refused (`unknown mode "basic"`), as designed |

The product surface is correct. The two defects below are both in the CLIENT half.

## 22. Defect 1: the bare package name is load-bearing, and RC7 broke it

**Symptom.** EF's Sidebar panel never appeared. `window.__DSH_BOOT__` listed 65
client modules and **none was EF**.

**Root cause.** DSH's client module system finds a package's browser half by
scanning the host Loader for a row whose `name` is an EXACT package specifier:

```js
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) { ... }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':')
    ? specifier : undefined;
}
```

`dsh-epistemic-fold` is accepted; `dsh-epistemic-fold/doctor` is **rejected** —
it contains a slash. Before RC7, EF had a top-level row named exactly
`dsh-epistemic-fold`, so the scan found the package. RC7 replaced that row with
`dsh-epistemic-fold/doctor` (the doctor), so the package became invisible to the
roster and its `client.js` was never served.

**Fix.** The bare name now mounts the DOCTOR (`src/entry.ts` re-exports it), and
the plugin moved behind `dsh-epistemic-fold/plugin`. That is the correct
assignment, not just a workaround: the bare name must be held by a row that
always mounts and is observation-only, and the doctor is exactly that. Mounting
the plugin there would create a root-plane engine whose surface reports on
sessions it never folds — the RC4-A defect.

**Why no test caught it.** Every unit test asserted the patch's row NAMES and the
client's exports; none asserted that the DSH client roster could still *find* the
package. The roster's rule (no slash) is an implementation detail of a different
subsystem, and it is now pinned by a test that names it.

## 23. Defect 2: a missing third-party plugin failed the whole web boot

**Symptom.** After fixing defect 1, the UI showed:

```
Failed to load plugins
web boot: 1 entry did not activate dsh-epistemic-fold:
pending (waiting for service: betterSidebar)
```

**Root cause.** `client.js` declared `inject: ['betterSidebar']`. `betterSidebar`
belongs to `dsh-better-sidebar`, a THIRD-PARTY plugin. A declared inject makes
cordis hold the entry in a pending state until the service appears — so on any
machine without that plugin, EF's client half never activates, and DSH treats the
unactivated entry as a **boot failure for the whole UI**.

The guarded body was already correct (`if (service === undefined) return`); the
*declaration* was what broke it. This is a distribution-critical defect: EF would
have made DSH unusable on a clean install.

**Fix.** The optional service is requested through cordis's `ctx.inject([...],
cb)` idiom, whose callback simply never runs when the service never appears. The
hard `inject` list is gone. Measured after: no boot error, and EF's module is in
the roster (66 entries).

## 24. What this says about the test strategy

Both defects were invisible to 684 passing tests and to every host-API probe.
They share one shape: **a contract between two subsystems that neither side's
tests assert** — the client roster's package-naming rule, and cordis's
pending-forever semantics for a declared inject.

The lesson recorded for future rounds: when EF integrates with a host subsystem,
the integration test must exercise the host's OWN discovery path, not EF's
assumptions about it. §19's open item — "T3/T4/T5/T8 are verified by observation,
not by a committed test" — is the same gap, and this session shows it is a real
one rather than a bookkeeping detail.

## 25. Status of the two defects

Both are fixed and verified in the real UI. New pinned tests:

| Test | Guards |
| --- | --- |
| `the bare name is load-bearing, and only the doctor may hold it` | defect 1 — the entry must be the doctor, and must not import the plugin |
| `the plugin stays reachable at its own subpath` | the plugin remains mountable for preset rows |
| `the client declares NO hard inject, so a missing sidebar cannot fail boot` | defect 2 |
| `does nothing when no sidebar service is ever mounted` | the optional idiom's two failure shapes |

684 tests pass, typecheck clean, build clean.
