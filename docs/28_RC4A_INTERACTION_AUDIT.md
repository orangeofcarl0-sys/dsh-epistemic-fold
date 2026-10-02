# RC4-A — Interaction Audit

Baseline: `main@f1ada3d` (RC4).
Scope: an audit of the interaction surface. Findings only; no fixes applied in this
document's own commit unless noted.

> **Headline.** The command plane is sound and was exercised case by case in a real
> host. Three findings mattered, in descending severity: **the panel is bypassed
> entirely in the profile that has a sidebar** (the web profile scopes compaction
> per agent preset, so sessions use DSH Basic, not EF); **the panel mislabelled a
> lifetime total as a current count** — the exact defect RC2.1 fixed on the command
> plane; and **every command failure was reported as `kind: 'success'`**, so a
> refused switch looked successful to the client.
>
> **Status.** A2, A3 and A4 are **FIXED** and pinned by tests.
>
> **All four are now closed.** A1 was fixed by RC7 (in-place preset
> substitution) and verified in a real browser session on 2026-10-03 — the
> session header renders the `standard` preset chip, which RC7 rewrote to run EF.
> A5 was **disproven**: the client factory loads with zero import errors, so the
> differing inject lists were never a defect. See
> [37_RC11_BROWSER_VERIFICATION.md](37_RC11_BROWSER_VERIFICATION.md).
>
> One caveat that document records: the RC7 fix reached a real profile only on
> 2026-10-03. Before that, every install carried an RC5-era build whose empty
> patch meant A1 was still live — which is why the blocker read as open here for
> so long.

---

## A1 — BLOCKER, FIXED (RC7; browser-verified 2026-10-03): in the web profile, sessions do not use EF

**Evidence.** The composed tree of a real web profile with EF added:

```
indent= 0 :: - id: compaction-basic        <- my patch disabled THIS one
  disabled: true

indent=10 :: - id: compaction-basic        <- three of these, ENABLED
  (no disabled)
```

The indent-10 rows live inside agent-preset groups:

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
```

My `cordis.patch.yml` disables the **top-level** row. `dsh-web-app` already
disables that top-level row itself — deliberately, with the reasoning recorded:
compaction is a per-session fact, so it belongs to the preset, not the host plane.
So my patch's target was already disabled, and the three copies that sessions
actually resolve are untouched.

**Why the disable is a no-op rather than harmless.** Cordis `isolate` gives a scope
its own registration, shadowing the parent — verified directly:

```
root: top-level
scoped context: scoped
root still: top-level
sibling(other isolate): top-level
```

A preset's agent resolves `ctx.compaction` from its own isolated scope, so it gets
**that group's Basic**, not the EF engine registered at the top level.

**Consequence.** In `ef-web`, EF activates (it is neither failed nor waiting), its
command registers, its projection publishes — and every session still compacts with
DSH Basic. The `/context status` figure for a web session would be reading folds
that EF never performed. This is the most serious finding because it is silent:
nothing errors, and the panel would show plausible numbers.

**Not yet confirmed end-to-end.** I confirmed the mechanics (the tree indentation,
the isolate semantics, and that EF itself activates) but could not boot the web UI
to watch a session fold, because the user's own DSH holds port 3080. Confirming it
against a live session needs that port or a different one.

**What a fix would have to be.** EF must be inserted into the same place Basic is —
inside each preset's `isolate: {compaction: true}` group — or the preset groups must
be patched to reference EF. That is a decision about how EF ships to web profiles,
not a one-line patch, and it is the kind of thing that should be verified by folding
a real web session.

---

## A2 — HIGH: FIXED — the panel mislabelled a lifetime total as a current count

```js
jsx.jsx(Row, { label: translate('checkpointsNow'), value: status.folds + status.roots })
```

`folds + roots` is the **lifetime** number of folds ever committed. `Checkpoints now`
claims the number **currently frozen on the surface**. Those differ the moment a root
rebase collapses the surface: a session that folded 40 times and rebased to one
checkpoint has 1 current checkpoint and 41 lifetime folds.

This is the same confusion RC2.1 corrected on the command plane, where
`checkpoints now` and `folds (lifetime)` are separate fields with names that say
which is which. The panel reintroduced it — and worse, under the *correct* label,
which makes it harder to notice than an unlabeled number.

**Root cause.** The projection carries only lifetime counts. A current checkpoint
count is derivable from the surface frontier, which a pure event fold cannot read;
it would need its own state (count checkpoints seen minus those a root rebased
away), which the fold could maintain from `compaction/summary` markers.

---

## A3 — HIGH: FIXED — every command failure was reported as success

Exercised in a real host, all 12 cases:

| input | result kind | text |
| --- | --- | --- |
| `/context` | success | mode report |
| `/context mode` | success | the ladder |
| `/context mode economy` | **success** | `cannot switch mode: …` |
| `/context mode turbo` | **success** | `unknown mode "turbo"; choose one of …` |
| `/context mode ECONOMY` | **success** | `unknown mode "ECONOMY"; …` |
| `/context nonsense` | error | `unknown subcommand …` |

`applyModeChange` returns a **string**, and the handler wraps whatever it returns as
`{ kind: 'success' }`. So a refused switch and a rejected tier name both reach the
client as successes carrying failure text.

The distinction is real and the client uses it: `ui-commands` checks
`result.kind === 'error'` when attachments are involved, and the command lifecycle
records `command/done` with `kind`. A deployment reading that log cannot tell a
refused switch from a successful one.

Sub-command typos are handled correctly (`error`), so the defect is localized to
the mode path.

---

## A4 — MEDIUM: FIXED — the panel could not show pressure, the directive's first UI item

The directive's panel spec leads with context pressure:

```
Context
████████████░░░░  47k / 131k
Fold threshold     65k
```

The panel has **no pressure, window, threshold or occupancy** — its projection
carries none of them, and `grep -c 'pressure|contextWindow|threshold|occupancy'
src/status-projection.ts` is `0`.

This one is a design consequence rather than an oversight: the projection is a pure
event fold, and pressure is not an event — it is a meter reading. The meter already
publishes a client-readable `contextPressure` projection (`pressureTokens`,
`projectedTokens`, `contextWindow`), and DSH's own `ContextMeter` reads it. So the
panel could join the two, but a projection cannot read another projection's value;
the join has to happen **in the panel** via a second `useProjection('contextPressure')`
call.

That is a small change and it is the highest-value one, because pressure is what
makes the panel answer the user's real question ("how much context am I actually
carrying?") rather than only the historical one.

---

## A5 — MEDIUM, DISPROVEN (2026-10-03): the client faces declare different inject lists

```jsonc
// package.json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] } }
// client.js
const inject = ['betterSidebar']
```

Both are real and they mean different things — `dsh.client.inject` is the module
graph (package rows, which must be loaded before this one), while the module's own
`inject` is the cordis service list. Neither is wrong on its face, but they were
written independently and nothing checks they agree. A reader cannot tell whether
`@deepseek-ai/dsh-client-ui-sidebar-right` is needed at all: the panel registers
through `betterSidebar`, which is provided by a different package.

**Not verified:** whether the declared graph edge is required. Confirming it needs
the web UI running, which port 3080 prevented.

---

## A6 — LOW: display polish the directive's spec asks for, absent

The directive sketches a mode selector (radio list), a pressure bar, and a
fold/recall timeline. The panel has none of the three: it is a read-only figure
list, the mode is a text label, and there is no timeline.

That is consistent with "第一版只做 mode + pressure + archive + fold/recall + cost",
so only the missing **pressure** (A4) is a gap against the stated first version. The
selector and timeline were explicitly "再往后", and the panel correctly does not
offer mode switching — control is the command plane's job, and mixing them would
break the division the directive establishes.

---

## A7 — Verified sound

Worth recording so the audit is not only a defect list:

- **The command surface is complete and robust.** `/context`, `/context status`,
  `/context line`, `/context mode`, `/context mode <tier>`, unknown sub-command,
  unknown tier, wrong case, extra arguments, doubled spaces and an unknown flag all
  behave defensibly; nothing throws.
- **Unknown is never zero.** `cost=unknown` on a session with no usage; the panel
  renders `—`; `ctx=unknown` in the line form.
- **The mode-switch guard works.** On an unpatched build, `mode economy` from
  `legacy` is refused with the reason and the engine is unchanged, rather than
  half-applied.
- **No compaction conflict from other plugins.** `auto-compact` and `dsh-contextvm`
  touch neither `compaction` nor `compaction-basic` rows.
- **The control and observation planes are wired together.** After a (refused)
  `/context mode`, the projection reported the engine's actual mode.

---

## What was fixed, and how

| finding | fix |
| --- | --- |
| **A3** | `applyModeChange` now returns a `{kind, text}` result instead of a string, so a rejected tier, a deployment with no switchable engine, and a refused switch are all `error`. Showing the ladder is still a success, because it is one. Verified in a real host: `mode turbo` → `error`, `mode` → `success`, `mode economy` (seam absent) → `error`. |
| **A2** | The projection gained `currentCheckpoints`, maintained from the checkpoint markers — a leaf JOINS the frozen prefix so the count grows by one, a root REBASES so it collapses to one. The panel now renders that under `Checkpoints now`, distinct from the lifetime `Leaf folds` / `Root rebases` rows. Pinned by a test that folds three times and then rebases, asserting `currentCheckpoints` is 3 then 1 while the lifetime total reaches 4. |
| **A4** | The panel joins DSH's own `contextPressure` projection through a second `useProjection` call — the join has to happen in the panel because a projection cannot read another projection's value. It renders `Pressure` and `Window`, and shows an em dash when either is absent. |

## Priority

1. **A1 — OPEN, and it gates RC4.** EF does not run in the profile the panel
   targets. Everything the panel reports in a web session would be about folds EF
   did not perform. Fixing it means EF must be inserted where Basic is — inside
   each preset's `isolate: {compaction: true}` group — which is a decision about
   how EF ships to web profiles rather than a one-line patch, and it should be
   verified by folding a real web session.
2. **A5 — OPEN.** Needs the web UI running to confirm whether the declared client
   graph edge is required.
3. **A6** — display polish deliberately out of the first version.
