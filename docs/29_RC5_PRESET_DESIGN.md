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

**Still not verified**, and it is the same gap as before: a live web session
selecting `ef-economy` and folding under it. That needs port 3080 free, because
the selection UI and the session composition both live behind the web host.

### One test-quality note

The drift test's first version used a hand-rolled YAML reader, which mis-parsed
the reference and reported a missing preset row. It was replaced with the real
`js-yaml` resolved from the DSH install — the repository has no YAML dependency,
and adding one to compare two files would be a dependency bought for a test.
