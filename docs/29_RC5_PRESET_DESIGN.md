# RC5 — EF as its own agent preset (design)

Baseline: `main@38deea7` (RC4-A).
Status: **IMPLEMENTED.** Three tier presets ship, generated from the installed
DSH; verified to coexist in the real web profile with zero conflicts.

> **Update (RC5 implementation).** This document was the design. It is now built:
> `scripts/generate-presets.mjs` emits `presets/ef-{economy,balanced,quality}.patch.yml`
> from the installed DSH reference, `package.json` declares them as a
> `dsh.bundle.patch` array, and `tests/rc5-preset-drift.spec.ts` fails when they
> stop mirroring DSH. See §9 for what implementation changed versus this design —
> one of the design's assumptions was WRONG and the first real boot caught it.

> **The idea in one line.** Instead of mounting EF over DSH's compaction backend
> and hoping it wins, EF **declares its own agent preset**; a session that selects
> it gets EF, and a session that does not is **untouched native Basic** — not a
> disabled EF, not a bypassed EF, but no EF code in the path at all.

---

## 1. Why this is the right shape

RC4-A found the blocker: in the web profile, `dsh-web-app` disables the top-level
`compaction-basic` and puts a compaction group inside **each agent preset**,
isolated by `isolate: { compaction: true }`. Cordis isolation means a scoped
context resolves its **own** registration and never sees the parent's, so EF
mounted at the top level is invisible to every session.

The tempting fix is to reach into each preset and swap its `compaction-basic` for
EF. That works mechanically (I verified it), but it is the wrong shape:

- the loader replaces a row's **whole `config`**, not a merge — so overriding
  `preset-standard` means restating its 137-line `plugins` list, and that copy
  **silently drifts** the next time DSH changes the preset;
- it has to be repeated for every preset (four today);
- and it means EF is force-installed into sessions whose owner never asked for it.

Declaring **a preset of EF's own** inverts all three: nothing is restated, nothing
drifts, and EF is present only where it was chosen.

---

## 2. What a preset actually is (verified)

A preset is a **loader row** that registers a definition:

```yaml
- id: preset-<name>
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: <name>            # identity, also the label fallback
    name: <display>       # optional
    description: <text>   # optional
    order: <n>            # optional, sort order
    plugins: [...]        # the child rows a session under this preset composes
```

Verified from `dsh-agent-preset/lib/index.js`: the plugin's entire body is
`yield await this.ctx.agentPresets.register(this.config)`, and its
`Config` schema requires exactly `id` and `plugins`.

`plugins` entries are ordinary loader rows — `{ id, name, config?, group?,
isolate?, disabled? }` — so they can name **any package**, including
`dsh-epistemic-fold`. That is the whole mechanism: EF does not need a new
extension point, it needs a row in a list it owns.

### The compaction group, verbatim

Every real preset wraps compaction the same way (`standard.patch.yml:63`):

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

EF's preset mirrors this group with **one row changed**:

```yaml
    - id: epistemic-fold          # was: compaction-basic
      name: dsh-epistemic-fold
      config:
        bundleRoot: null
        mode: economy
```

That single substitution is the entire integration. `command-compact` and
`tool-result-pruner` stay, because they are backend-independent (the base bundle
says so explicitly: *"Backend independent, so it follows whichever compaction
service this leaf mounts"*).

---

## 3. What "zero coexistence" means, precisely

This is the property worth stating carefully, because it is stronger than
"EF is disabled".

| | EF mounted at top level (today) | EF as its own preset |
| --- | --- | --- |
| EF code loaded in a Basic session | **yes** — the plugin constructs, registers a projection, registers `/context`, registers the recall tools | **no** |
| EF engine constructed | yes | no |
| EF bundle store opened | yes | no |
| `/context` command present | yes (reports EF facts that are not happening) | no |
| recall tools visible to the model | yes | no |
| compaction path | Basic, via the preset's own group | Basic, via the preset's own group |

So the difference is not "does EF run" — in both cases the session compacts with
Basic. The difference is that today **EF is present and lying**: its command and
its panel report fold counts, archive size and mode for folds EF never performed,
because the engine that would have done them is bypassed. Under the preset
approach a Basic session has **no EF surface at all**, so there is nothing to
misreport.

That is what "zero coexistence" buys: the failure mode RC4-A found — plausible
numbers describing work that did not happen — becomes structurally impossible
rather than merely unlikely.

---

## 4. How the user selects it

Selection is a **before-the-fact, per-session** choice. From the client package's
own documentation:

> a chip on the new-session screen for the session about to start, a read-only
> label in the session header, and a settings section that lists the roster
> […] **A running session keeps the composition it began with** (the host refuses
> to adopt an existing session under a different preset).

And:

> Developer tools (General settings) are the single gate over selection: with them
> off the chip disappears and the card actions are disabled, while the saved
> default keeps composing new sessions.

So the user flow is:

1. install EF as a plugin (one `dsh plugin add`, same as any bundle);
2. open a new session, pick `EF · economy` (or balanced / quality) from the chip;
3. that session runs EF. Every other session, before and after, is native Basic.

There is also a **"make default"** action, so a deployment that wants EF
everywhere sets it as the default and stops choosing.

### The one real constraint

**`/context mode` cannot switch a running web session.** The host refuses to
recompose a started session, so a tier is fixed at session start. This is DSH's
deliberate design, not a limitation of the approach.

That collides with RC2's control plane, and the honest resolutions are:

- **Three presets** — `ef-economy`, `ef-balanced`, `ef-quality`. The tier becomes
  the thing you pick, and `/context mode` becomes read-only in web sessions
  (still meaningful in headless/CLI, where the profile fixes it anyway).
- **One preset + a config key** — the deployment picks the tier in `config`, and
  `/context mode` is dropped from the product surface entirely.

I would take the first: it keeps the three tiers user-visible, which is the whole
point of having them, and it makes the choice explicit at the moment it can still
be made.

---

## 5. What EF has to ship

```
cordis.patch.yml          # REPLACED: declares presets instead of mounting EF
  - insert:
      - id: preset-ef-economy
        name: '@deepseek-ai/dsh-agent-preset'
        config:
          id: ef-economy
          name: 'EF · economy'
          description: 'Lowest cost; quality measured at parity with Basic'
          order: 10
          plugins:
            - <the standard preset's non-compaction rows, restated>
            - id: compaction
              name: cordis:group
              group: true
              isolate: { compaction: true, toolResultPruner: true }
              config:
                - id: epistemic-fold
                  name: dsh-epistemic-fold
                  config: { bundleRoot: null, mode: economy }
                - id: command-compact
                  name: '@deepseek-ai/dsh-command-compact'
                - id: tool-result-pruner
                  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

### The honest cost, stated plainly

The preset's non-compaction rows **must be restated** — persona, tools, skills,
instructions, and whatever else the session needs. That is **19 top-level rows**
today for `standard` (persona, agent-instructions, tool-bash, tool-pwsh, tool-fs,
tool-fs-search, tool-jobs, skill-filesystem, tool-skill, command-goal, tool-goal,
planning, compaction, delegation, tool-ask-user, tool-todo, tool-web, present,
tool-plugin-manager), and it is the same drift risk I criticised in the override
approach, just moved: if DSH adds a tool row to `standard`, EF's preset will not
have it.

Three ways to reduce it, none free:

1. **Ship a minimal preset** (like `minimal`: persona + shell, 2 rows) and accept
   that an EF session is a leaner agent than a standard one. Honest, small, but a
   real capability difference the user must understand.
2. **Ship a full mirror of `standard`** and accept the drift, with a test that
   diffs EF's preset against the installed `standard.patch.yml` and fails loudly
   when they diverge. The drift becomes visible instead of silent — which is the
   property that matters.
3. **Ask upstream** for preset inheritance (`extends: standard`), so EF states
   only its delta. `AgentPresetRegistry` already has `composeFrom` /
   `composedPreset` for joining a child to its parent's revision, so the concept
   exists in the codebase; whether a *declaration* can extend another is not
   something I have confirmed.

I would do **(2) with the diff test**, and open (3) as an upstream question.

---

## 6. What this does not solve

- **The framing seam.** Every EF tier needs `frameCheckpoint`, which released DSH
  does not have. A preset does not change that: `mode: economy` still refuses to
  start on an unpatched build. The preset's default should therefore be a
  seam-free configuration, or the tier choice has to be gated on the seam's
  presence.
- **The cost gate.** Still OPEN, still a pricing question.
- **Tier benefit.** Still a HYPOTHESIS.

---

## 7. Recommended path

1. **Ship one preset first** (`ef-economy`) to prove the shape end to end on a
   real web session: select it, fold, see `EF1` markers and bundles; then select
   `standard` and confirm **no EF surface exists at all**.
2. **Add the drift test** — EF's preset versus the installed `standard`, failing
   when they diverge.
3. **Then decide on three presets vs one.** That is a product decision about
   whether the tier is chosen per session or per deployment, and it depends on
   whether losing `/context mode` in web sessions is acceptable.

Step 1 is the one that matters: it is the first thing in this project that would
make EF *usable in the profile that has a sidebar*, which is what RC4 set out to
do and could not.

---

## 8. What was verified (prototype)

I built the prototype against the real web profile and confirmed the mechanism,
short of a live session fold:

1. **Extracted `standard`'s real row list** (19 top-level rows + its compaction
   group) from the installed `standard.patch.yml`, substituted EF for
   `compaction-basic` inside the compaction group, and emitted it as a new
   `preset-ef-economy` declaration. 19 rows carried over, as expected.
2. **The composed tree is correct.** `--dump-config` shows `preset-ef-economy`
   with `id: ef-economy`, `order: 10`, and the full plugins list, with EF inside
   the `isolate: { compaction: true }` group where `compaction-basic` used to be.
3. **It activates cleanly.** Booting the profile produces **no** preset error, no
   EF error, and no "did not activate" entry for either — the only failure is
   `EADDRINUSE` on port 3080, which is this machine's own running DSH.

**Not verified**, and this is the remaining gap: an actual session selecting
`ef-economy` and folding under it. That needs port 3080 free, because the
selection UI and the session composition both live behind the web host. The
mechanism is confirmed; the end-to-end behaviour is not.

**Environment left as found.** The prototype lived in the throwaway
`~/.dsh/profiles/ef-web` and has been reverted; the user's real `web` profile was
never touched.

---

## 9. What implementation changed versus this design

### The isolate realm — the design's one wrong assumption

The design said the substitution was "one row". **It was two.** The first real
boot failed:

```
agent preset ef-economy: Preset services require isolate realms: epistemicFold
service "epistemicFold" has been registered at <EpistemicFoldPlugin>
```

`AgentPresetRegistry` audits every mounted preset with `leakedServices()`: a
service whose registration lands in the ROOT isolate realm is a leak, because the
SECOND preset to mount the same plugin collides on it. EF's
`ctx.provide('epistemicFold', …)` did exactly that — and since EF ships three
presets, the collision was certain, not hypothetical.

The fix is the one DSH itself uses for `compaction`, `toolResultPruner` and
`planMode`: name the service in the group's `isolate:` map, so each preset's mount
provides it into its OWN realm.

```yaml
isolate:
  compaction: true
  toolResultPruner: true
  epistemicFold: true        # <- the second row the design missed
```

The generator now adds it and THROWS if the group has no `isolate:` map to add it
to, so the failure cannot come back silently.

This is worth recording because it is the second time in this project that a real
host found something no amount of reading had: RC3's `ctx.get('tools')` throw, and
now this. Both were invisible to a harness that mounts one instance at a time.

### What the generator does that the design did not specify

- **Emits one file per tier** rather than one file with three rows, mirroring
  `dsh-web-app`'s own layout, so regenerating a tier cannot disturb the others.
- **Reads the reference from the installed DSH** (`$DSH_HOME`, default `~/.dsh`)
  and refuses to run without one — inventing a preset from memory would be the
  hand-copy the design rejected.
- **Keeps `command-compact` and `tool-result-pruner`** in the group, which the
  design anticipated and the implementation confirmed: the base bundle documents
  them as backend-independent.

### Verification performed

| check | result |
| --- | --- |
| three presets compose into the tree | `--dump-config` shows all three with EF inside the isolated compaction group |
| they coexist at boot | **zero** EF lines, zero `already registered`, zero `isolate realms` errors |
| the mirror is real | 19 non-compaction rows compared row-by-row against the installed reference |
| the drift test actually guards | deleting ONE row (`tool-web`) fails 3 tests; restored, 5 pass |

### End-to-end verification (RC5-E2E)

The gap above is now CLOSED. Driven against a real DSH 0.2.0-rc.2 composed by the
CLI's own `runProfile` — the same code path the `dsh` binary uses — with the web
host moved to a free port so the user's own running DSH was not disturbed.

**The presets are real and selectable.** The real web UI's preset menu lists
seven entries: DSH's four plus `EF · economy`, `EF · balanced`, `EF · quality`,
each with its description. They are registered, not broken, and carry the same
enabled state as DSH's own items.

**The composition is the whole claim, verified per session.** In one real
context, two sessions bound to two presets:

| session bound to | its `ctx.compaction` | carries EF recall tools |
| --- | --- | --- |
| `standard` | `BasicCompactionEngine` | no |
| `ef-economy` | **`EpistemicFoldEngine`** | yes |

`composedPreset(agent.ctx)` returns `ef-economy` for the second and the registry's
`serviceFor(agent, 'compaction')` resolves to the EF engine — which is the
authoritative statement that the preset's isolated realm really is what the
session reads. The composition documents agree: `standard` contains
`compaction-basic` and no EF; `ef-economy` contains EF and no `compaction-basic`.

So "zero coexistence" is measured, not asserted: a `standard` session in this
profile has **no EF engine**, and the two sessions in the same process resolve
different compaction backends.

**What this still does not cover.** The sessions above were bound and their
engines resolved, but no turn was run through the model, so EF has not been
observed *folding* inside a web-preset session. That distinction matters and is
recorded rather than glossed: RC3 already proved EF folds in a real DSH session
(two committed transactions, `EF1` markers, bundles on disk) — but under a
top-level mount, not under a preset. The preset path adds only the binding, which
is what this run verified.

One environment note: the run needed the framing seam temporarily present, because
every tier requires `frameCheckpoint` and released DSH does not have it. The patch
was reverted afterwards; the user's install is vanilla again.

### One test-quality note

The drift test's first version used a hand-rolled YAML reader, which mis-parsed
the reference and reported a missing preset row. It was replaced with the real
`js-yaml` resolved from the DSH install — the repository has no YAML dependency,
and adding one to compare two files would be a dependency bought for a test.

## 10. Can EF be *invisible* — added on top of DSH's four presets?

The question that motivated this section: why must EF add a menu item at all,
rather than being added *invisibly* on top of the existing four? The answer was
established by experiment against the installed DSH 0.2.0-rc.2, not by reading
the design.

### What the loader can and cannot address

`applyEntryPatches` (in `@deepseek-ai/cordis-plugin-include`) builds its id index
by recursing **only** into rows that carry both `group: true` and an *array*
`config`. A preset row is `name: '@deepseek-ai/dsh-agent-preset'` with an
*object* `config` whose `plugins` key holds the child list, so the compaction
group inside it is never indexed. Measured on the composed tree:

| Patch id | Result |
| --- | --- |
| `compaction-basic` | `entry not found` |
| `preset-standard:compaction:compaction-basic` | `entry not found` |
| `preset-standard:compaction` | `entry not found` |
| `preset-standard` (whole-config override) | **applies** |

Nested path addressing is not implemented in this loader despite
`EntryTree.resolve` supporting `:`-separated nested ids — that resolver belongs
to the live tree, not to the patch algorithm. So the only way to substitute EF
inside an existing preset is to override that preset's **whole config**, which
means restating its 19 top-level rows (32 flattened) in a file that then drifts
silently. That is the same objection §1 already raises, and it is why the
shipped design declares EF's own presets instead.

### The substitution does work — and it keeps the menu at four

A whole-config override *can* swap the backend. Composed with DSH's own
algorithm, then booted for real in a throwaway profile:

```
- id: preset-standard
  config: { ...DSH's own config, with compaction-basic -> dsh-epistemic-fold
            and epistemicFold added to the compaction group's isolate map }
```

Result: roster `standard, ptc, minimal, cordis` — four items, unchanged — and a
session bound to `standard` resolves `ctx.compaction` to `EpistemicFoldEngine`.
So the invisible option is real, not hypothetical.

### Why it is nevertheless not the shipped design

Two measured obstacles decide it.

**1. A tier cannot mount in that slot on vanilla DSH.** Every tier sets
`framingMode: system-dedup`, which requires the `frameCheckpoint` seam that no
released DSH build has (`typeof BasicCompactionEngine.prototype.frameCheckpoint
=== undefined`, verified against the installed package). Substituting
`mode: economy` broke the whole preset:

```
standard   broken=YES  compaction=SELECT FAILED: epistemic-fold: framingMode "system-dedup" requires ...
ptc        broken=no   compaction=BasicCompactionEngine
cordis     broken=no   compaction=BasicCompactionEngine
```

The blast radius is the problem: a broken row does not merely remove EF, it
takes the **entire preset** with it, including the user's `standard` default and
every other capability that preset carried. The composer chip filters broken
presets out (`presets.filter(p => p.broken === undefined)`), so the item would
silently vanish from the picker. Substituting a *tier* therefore degrades the
user's DSH to the point where their default preset cannot start a session.
Substituting seam-free (`mode: legacy`, or economy's policy with `framingMode:
legacy`) does mount — but then it is not the measured economy arm, so the cost
claim RC1.3 established no longer applies to what the user is actually running.

**2. Invisible and opt-in are mutually exclusive here.** Substituting in place
means *every* session of that preset runs EF with no in-DSH way to choose Basic,
because the preset identity the user sees (`standard`) no longer names what runs.
There is no hide flag on a preset definition to make a selectable-but-invisible
row: `PresetDefinition` is exactly `{ id, name?, description?, order?, plugins }`,
and the roster exposes `broken` but no visibility control. A command could switch
the tier, but not turn EF off in favour of Basic — and because one preset shares
one engine (`efConfig === ` across two sessions of the same preset, verified),
a `/context mode` switch in one session also changes its siblings' engine.

### The conclusion

"Invisible" is achievable only by giving up "opt-in", and on this DSH build it
also means shipping the seam-free configuration rather than the measured one. The
declared-preset design keeps both: not selecting an EF preset is native Basic
with no EF surface at all, and the four DSH presets are byte-identical to what
DSH ships. The extra menu items are the price of that, and they are labelled with
what they are.

## 11. The ORIGINAL method, re-measured — and one claim corrected

Before the in-place substitution above, EF mounted itself the other way, and the
question "what about the original method?" deserves a measured answer rather than
the RC4-A note it was dismissed with. That method was a profile-layer patch:

```yaml
- insert:
    - id: epistemic-fold
      name: dsh-epistemic-fold
      config: { bundleRoot: ..., mode: legacy, auto: true }
- id: compaction-basic      # the TOP-LEVEL row
  disabled: true
```

Booted for real in a web profile, it behaves as RC4-A recorded for the host
plane — and the recorded conclusion still holds:

```
HOST ctx.compaction = EpistemicFoldEngine
MENU SIZE: 4 -> standard, ptc, minimal, cordis
  standard   broken=no   compaction=BasicCompactionEngine
  ptc        broken=no   compaction=BasicCompactionEngine
  cordis     broken=no   compaction=BasicCompactionEngine
```

The host row mounts EF, but every **web session still runs Basic**, because
`dsh-web-app` disables the top-level `compaction-basic` itself and gives each
preset its own `isolate: { compaction: true }` group. The host engine is real and
unreachable. Worse, and this is the part that makes it a BLOCKER rather than an
inert no-op: EF's *observation* plane is still mounted for those sessions —

```
session compaction backend: BasicCompactionEngine
epistemicFold.status stateOf -> {"mode":"legacy","folds":0,"roots":0,...}
/context present for a Basic-preset session: true
```

— so the Sidebar panel and `/context` report an EF that is not compacting that
session. A fold counter that reads 0 while Basic folds is a false negative that
looks like "EF is idle", not like "EF is not running". That is exactly the
mislabelling class this project treats as a blocker.

### The variant that does work

The same top-level EF becomes *effective* if each preset's compaction group stops
isolating the service and drops its local row, so sessions inherit the host's:

```
HOST ctx.compaction = EpistemicFoldEngine
MENU SIZE: 4 -> standard, ptc, minimal, cordis
  standard   agent.ctx.get('compaction') = EpistemicFoldEngine
  ptc        agent.ctx.get('compaction') = EpistemicFoldEngine
  minimal    agent.ctx.get('compaction') = EpistemicFoldEngine
  cordis     agent.ctx.get('compaction') = EpistemicFoldEngine
```

`bundleStore`, `efConfig` and `rebaseIntentRegistry` are all identical to the
host engine's across every preset (`sameStore=true sameCfg=true
sameRebaseRegistry=true`), so exactly **one** engine serves all four — and the
menu is still DSH's four. That the engine is genuinely *driven* and not merely
resolved was checked separately: a host-registered `agent/pre-step` middleware
runs for a preset-session event (1 call), which is how the engine wires itself.

But this variant restates all four preset rows to remove two lines each, which is
the drift objection of §1 again, and it changes `minimal` — a preset DSH ships
with **no compaction at all** — into one that folds with EF. It is also the
variant with no escape hatch: no session resolves `BasicCompactionEngine`, so a
user cannot get native Basic back without editing the patch. So the original
method is not "wrong"; it is a different trade: one engine for the whole process,
all four presets changed in place, and no way to opt out.

## 12. "EF 内置 Basic" — measured, and what it would actually take

The proposal: use the host-level replacement (one engine for all presets, no
isolation) and give EF a Basic mode inside itself, so an un-opted-in user gets
something indistinguishable from native Basic. This is the most attractive
version of "invisible", because it removes the menu items *and* keeps an opt-out.
It was tested rather than argued.

### Result 1: EF's checkpoint body is never Basic's, on any path

Basic and EF were run on the same session with the same budgets. Basic's body:

```
<compacted-summary>SEMANTIC-SUMMARY-MARKER</compacted-summary>
```

EF's body, under `mode: legacy` (EF's own default):

```
<compacted-summary>[EF1 L cp:a183e16f-...]
Rationale
- SEMANTIC-SUMMARY-MARKER</compacted-summary>
```

The `[EF1 …]` line is stamped by `renderSemanticCheckpoint`, which every
publishing path calls, and `renderFallbackCheckpoint` stamps it too. Every EF
configuration tried — `mode: legacy`, `mode: legacy` + `semanticMode: none`,
`mode: economy` + `framingMode: legacy`, and even a run with the projection
deliberately unmounted — produced a marked body. `semanticMode: none` shrinks it
to the bare marker line; nothing removes it.

That marker is load-bearing: `parseCheckpointMarker` is how
`locateFoldFrontier` distinguishes EF checkpoints from inherited Basic ones
(`readEfCheckpoint` returns `undefined` for a markerless checkpoint, and the
frontier treats those as history EF inherited). So "EF emits Basic-identical
checkpoints" is not a formatting change; it would mean the frontier can no longer
identify its own frozen prefix.

The checkpoint **source** is identical (`kind=compact-checkpoint`, with a
`compactionId`) on both engines — identity is already carried out-of-band. Only
the model-visible body differs, and that is exactly the part the marker protocol
owns.

### Result 2: a `super`-call is not a pass-through

Basic's `compactIfNeeded` was invoked directly on an EF instance. EF's overrides
were re-entered mid-call:

```
EF overrides re-entered during a BASIC compactIfNeeded call:
  compactRegion -> summarize -> frameCheckpoint -> compactRegion
threw: epistemic-fold: leaf_before_frontier — a leaf fold may not compact frozen history
```

Virtual dispatch means Basic's own methods call straight back into EF's
overrides. Adding `return super.compactIfNeeded(...)` as a "be Basic" branch
therefore does **not** produce Basic behaviour — it produces EF's invariants
running on a span selected by Basic's policy, which is precisely the state EF's
frontier guards exist to refuse. A real basic mode needs a branch at **every** one
of EF's five divergence points (`compactIfNeeded`, `compactRegion`, `compactNow`,
`summarize`, `frameCheckpoint`), each bypassing its own invariant — i.e. a second
engine's worth of code paths living inside the first, with EF's hard invariants
switched off by a flag.

Composition was also checked: a second `BasicCompactionEngine` cannot be
constructed on the same context (`service "compaction" has been registered at
<root>`), so EF cannot simply *hold* a Basic instance and delegate to it — one
compaction service per context, and EF is already it.

### What this means

The proposal is implementable, but its cost is not a config default. It requires
(a) teaching EF a second, invariant-free mode that reproduces Basic at five
override points, (b) resolving the marker conflict, since the frontier's identity
protocol currently depends on a marker that a Basic-identical body must not
carry, and (c) accepting one engine for the whole process with no per-preset
choice. That is a change to the compression architecture — the thing this project
froze — not to the integration layer.

Weighed against it: the shipped design already gives "invisible" in the sense that
matters for cost and correctness — a user who never selects an EF preset runs
native Basic byte-for-byte, because EF is not in that composition at all. The
price is three extra menu entries, each labelled with what it is.

## 13. Correction: "copy Basic into EF" — the reframing that changes §12

§12 concluded that a Basic-compatible mode would be a compression-architecture
change. That conclusion was drawn against a *subclass* whose base is the host's
own `@deepseek-ai/dsh-compaction-basic`. The proposal to **copy** Basic into EF
is materially different, and it invalidates two of §12's three objections. This
section records the correction.

### What the copy changes

**1. It removes the seam dependency — which is the blocker that actually matters.**

EF's tiers all set `framingMode: system-dedup`, which needs the `frameCheckpoint`
hook. Measured against the two builds:

| Base class | `frameCheckpoint` present | Tiers |
| --- | --- | --- |
| vendored `0.1.7-rc.2` (seam applied) | yes | mount |
| **installed `0.2.0-rc.2` (what a user has)** | **no** | **refuse to mount** |

So on a real DSH, every tier refuses to start — the failure seen in §10 as
`standard broken=YES`. `detectDshCapabilities()` probes whatever base class EF
extends. If EF extends **its own copy** with the seam inline, the probe reports
the capability of EF's own code and `assertDshCompatibility('system-dedup')`
passes on any host build. Verified by simulation (EF's base resolving to a
seam-carrying copy): all four modes mount, and the guard passes.

That is the whole reason the seam was ever a deployment prerequisite, and a copy
deletes it: the seam stops being a DSH feature EF needs and becomes a line in
EF's own source.

**2. A pass-through is cheap, and it is five branches, not an architecture.**

§12 measured that a *single* `return super.compactIfNeeded(...)` branch is not a
pass-through, because virtual dispatch re-enters EF's overrides
(`compactRegion -> summarize -> frameCheckpoint -> compactRegion`). That is
correct, and it is also the smaller half of the story: branching at **all five**
divergence points (`compactIfNeeded`, `compactRegion`, `compactNow`, `summarize`,
`frameCheckpoint`) does produce Basic exactly. On an identical session with a
landed fold:

```
BASIC            <compacted-summary>SEMANTIC-SUMMARY-MARKER</compacted-summary>
EF basic-mode    <compacted-summary>SEMANTIC-SUMMARY-MARKER</compacted-summary>
BOTH FOLDED: true     IDENTICAL: true     EF wrote a bundle: false
```

No `[EF1 …]` marker, and no bundle — so §12's marker/frontier objection does not
apply either: in basic mode the fold never becomes an EF checkpoint, because
`summarize` delegates before any marker is stamped. The frontier is unaffected
because there is nothing for it to misread.

So §12's "five override points, each bypassing its own invariant" is the correct
*shape*, but calling it a second engine was wrong. With the copy, those branches
are `return BasicCopy.<method>(...)` — the invariants are not switched off, they
are simply not reached.

### The maintenance question, stated honestly

A copy does need re-syncing when DSH changes: the vendored reference is
`0.1.7-rc.2` and the user's install is `0.2.0-rc.2`, so drift is real, not
hypothetical. But the work is mechanical and already scripted — the seam is ten
exact edits that `scripts/apply-framing-seam.mjs` applies and verifies, and the
same drift-test pattern used for the presets (`tests/rc5-preset-drift.spec.ts`)
can pin the copy against the installed reference so divergence fails a test
rather than rotting silently. The upstream package is MIT, so vendoring is
permitted with its notice preserved.

### What it would deliver

Combined with §11's host-level replacement, the copy gives the design that
resolves every objection raised in this document:

| Property | Status under this design |
| --- | --- |
| Menu items added | **none** — DSH's four, unchanged |
| Runs EF by default | yes, with no opt-in step |
| Opt-out to native Basic | **yes** — EF's own basic mode |
| Tiers mount on vanilla DSH | **yes** — EF owns the seam |
| One engine per process | yes (so `/context mode` is process-wide, not per-session) |

### What it does not remove

The remaining costs, so the trade is not overstated:

1. **Preset rows must still be restated** to drop each compaction group's
   isolation, which is §11's drift objection — the same pattern, and the same
   drift test can cover it.
2. **`minimal` gains compaction** it was never shipped with, since the host-level
   engine serves every preset.
3. **Tier choice is process-wide.** One engine serves all presets, so a
   `/context mode` switch affects every session — acceptable for a single-user
   desktop, not for per-session policy.
4. **Basic-parity is a claim that needs a standing differential test.** The
   result above is one session on one fixture. Shipping basic mode as the default
   means the equivalence must be continuously re-proved against the copy, which
   is a new test obligation this project does not currently carry.

Items 1–3 are integration work. Item 4 is the real one: it converts "EF is
invisible" from a deployment property into a *tested* property, which is the
right trade only if that test is written before the mode ships.

## 14. "Top-level replacement is optimal" — yes, with one defect found in §11

§11 described the working variant as "drop each compaction group's isolation and
its local row". Measured, that instruction is **underspecified and silently
loses a capability**. This section records the defect and the corrected recipe.

### The defect

`dsh-web-app` disables the HOST `tool-result-pruner` row and places a copy inside
each preset's compaction group, which isolates **two** service keys:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true      # ← the second key, easy to miss
  config:
    - id: compaction-basic
    - id: command-compact
    - id: tool-result-pruner
```

Removing only `compaction` from the isolate map (what §11 said) leaves the pruner
in the preset's realm while the host-level EF cannot see it:

```
  standard  engine=EpistemicFoldEngine pruner@agent=false pruner@engine=false
  minimal   engine=EpistemicFoldEngine pruner@agent=false pruner@engine=false
HOST toolResultPruner present: false
```

`EF` reads `this.ctx.get('toolResultPruner')` and skips pruning when it is
absent, so this is not a crash — it is a **silent** loss. And the loss is total,
because the pruner's only caller is the compaction engine
(`grep pruneSession` finds exactly two call sites, both in
`dsh-compaction-basic`, plus EF's own). In this configuration the preset's pruner
is mounted and **nobody calls it**: the host EF cannot reach it, and the preset
has no compaction engine of its own to call it.

So the naive variant silently disables tool-result pruning — the M1 ingress
reduction R1 measured as a real cost lever — while every surface still reports
healthy. That is the same failure class as the RC4-A blocker.

### The corrected recipe

De-isolate **both** keys and lift the pruner row to the host plane:

```
  standard  engine=EpistemicFoldEngine pruner@agent=true pruner@engine=true
  minimal   engine=EpistemicFoldEngine pruner@agent=true pruner@engine=true
HOST toolResultPruner present: true
MENU: standard, ptc, minimal, cordis
```

The pruner must be mounted at the host plane for this to work, since the engine
that calls it is the host engine. Note this also means the pruner's config
(`thresholdChars` / `headChars` / `tailChars`) moves from four per-preset copies
to one host row — a single place to keep, which is the same de-duplication the
top-level EF itself performs.

### On "optimal"

Top-level replacement is the right **integration shape** — it is the only variant
that leaves DSH's menu at four items while running EF everywhere. But it is not
sufficient on its own, and the two findings compose:

| Need | Solved by |
| --- | --- |
| No extra menu item | top-level replacement (§11) |
| EF runs by default, everywhere | top-level replacement |
| Tiers mount on vanilla DSH | **the copy (§13)** — host Basic has no seam |
| Opt out to native Basic | **the copy (§13)** — EF's basic mode |
| Tool-result pruning keeps working | full de-isolation (this section) |

Without the copy, top-level replacement can only run `mode: legacy`: the tiers
need the seam, and without it every preset that hosts EF reports broken — the
failure §10 measured. So the complete design is top-level replacement **plus** the
Basic copy, not either alone.

The costs that remain are §13's: preset rows must still be restated (now three
rows removed per preset rather than two), `minimal` gains compaction, tier choice
is process-wide, and Basic-parity needs a standing differential test.

## 15. Correction: substitution INSIDE the existing compaction group beats §11's recipe

§11/§14 described the top-level variant: mount one EF at the host plane and
de-isolate each preset's compaction group so sessions inherit it. Measured
against the third option — **replace only the `compaction-basic` row inside each
preset's EXISTING compaction group, leaving that group's isolate realm intact** —
the top-level variant is worse on every axis. This supersedes §11 and §14.

### The measurement

Both profiles were booted for real and every preset's session resolved through
the registry's own accessor:

```
VANILLA (baseline)
MENU: 4 -> standard, ptc, minimal, cordis
  standard  compaction=BasicCompactionEngine  pruner=ToolResultPruner
  ptc       compaction=BasicCompactionEngine  pruner=ToolResultPruner
  minimal   compaction=(NONE)                 pruner=(NONE)
  cordis    compaction=BasicCompactionEngine  pruner=ToolResultPruner

IN-PLACE SUBSTITUTION (only the compaction-basic row swapped, isolate kept)
MENU: 4 -> standard, ptc, minimal, cordis
  standard  compaction=EpistemicFoldEngine    pruner=ToolResultPruner
  ptc       compaction=EpistemicFoldEngine    pruner=ToolResultPruner
  minimal   compaction=(NONE)                 pruner=(NONE)
  cordis    compaction=EpistemicFoldEngine    pruner=ToolResultPruner
```

The in-place column is the vanilla column with exactly one cell changed per
preset. Everything §11/§14 had to repair by hand is simply untouched:

| Property | Top-level variant (§11/§14) | In-place substitution |
| --- | --- | --- |
| Menu size | 4 | 4 |
| `minimal` | **gains compaction it never shipped with** | unchanged (`NONE`) |
| `toolResultPruner` | **must be lifted to the host plane or silently lost** | preserved automatically |
| `isolate:` block | must be **removed** (and removal is what broke the pruner) | kept as DSH wrote it, plus one key |
| Rows restated per preset | 19 (all) | 19 (all — the whole `config` is replaced, so this is unchanged) |
| Mode scope | **process-wide** — one engine for all presets | **per-preset** |

The per-preset row is the significant one. Measured:

```
standard engine === ptc engine: false
standard vs ptc share bundleStore: false
two standard sessions share bundleStore: true
after setMode on standard -> ptc mode: legacy (leak: false)
```

So in-place substitution keeps §11's mode-leak problem from arising at all: a
`/context mode` switch affects the sessions of ONE preset, not the process. §13
listed "tier choice is process-wide" as an accepted cost; that cost was an
artifact of the top-level variant, not of the design.

That the engine is genuinely *driven* (not merely resolvable) was checked
separately: a listener registered at the engine's own scope receives an
`agent/pre-step` emitted at the agent's scope (1 call), and a direct
`compactIfNeeded` reaches EF's code with `tokenMeter` and `llm` both present.
The same probes were run against vanilla Basic as a control.

### Why the realm stays correct

The compaction group already declares `isolate: { compaction: true,
toolResultPruner: true }`, so the group's rows resolve their own compaction
service and their own pruner. Substituting the provider row means the group's
`command-compact` and `tool-result-pruner` find EF instead of Basic, inside the
same realm, with no host-plane involvement. This is also why `dsh-argp`'s
`src/preset-cleaner.ts` removes the `isolate:` block only when it removes the
rows as well — leaving `isolate:` with no provider inside makes `command-compact`
"wait forever". In-place substitution never creates that state.

### What still blocks it

A **tier** in that slot still refuses to mount on vanilla DSH, for the same
reason as §10:

```
standard  compaction=ERR: compaction-basic (dsh-epistemic-fold): e ...
ptc       compaction=ERR: ...
cordis    compaction=ERR: ...
```

`mode: economy` needs `framingMode: system-dedup`, which needs the
`frameCheckpoint` seam the installed `0.2.0-rc.2` does not have. So §13's
conclusion stands and is now the *only* remaining blocker: **the copy is
required**. In-place substitution replaces §11's recipe; it does not replace the
copy.

### The assembled design

Top-level replacement is therefore **not** the optimal shape. The optimal shape
is:

1. **In-place substitution** — one row per preset, menu stays at four, `minimal`
   and every pruner untouched, mode scoped per preset (this section).
2. **The Basic copy** — EF owns framing, so tiers mount on any DSH build, and
   EF can contain a byte-identical Basic mode (§13).
3. **No extra presets** — `presets/ef-*.patch.yml` and the three menu items are
   retired; the four DSH presets are the surface.
