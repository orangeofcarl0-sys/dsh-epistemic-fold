# RC4 — Sidebar Panel: Command = Control, Sidebar = Observation

Baseline: `main@c8927f1` (RC3 merged).
Scope: the observation plane. No context or retrieval research.

> **One-line result.** The Sidebar panel ships as a second renderer over the SAME
> status model the command already uses — not a panel that runs `/context status`
> and parses its text. `/context mode <tier>` is the control plane; the panel is
> the observation plane; and the panel was built **without adding a bundler**,
> because the DSH client format is hand-writable and EF must not grow a UI build
> pipeline.

---

## 1. The architecture, as implemented

```
                EpistemicFoldPlugin
                       │
             ┌─────────┴──────────┐
             ▼                    ▼
      Command plane         Status projection
      (ctx.commands)     (epistemicFold.status)
             │                    │
   /context status          wire view
   /context line                 │
   /context mode <tier>          ▼
             │            DSH Sidebar panel
             ▼            (dsh-epistemic-fold/client)
        text for a human    a React tab
```

Both render the SAME facts. The command reads `buildContextStatus()` directly;
the panel reads a projection whose `view()` produces the equivalent figures. The
panel never executes the command.

### Why the projection is a SEPARATE model, not `buildContextStatus`

A `SessionProjectionRegistry` unit must be a **pure fold**: `apply(state, event)`
sees committed session events and nothing else, and `view(state)` sees only that
state. It cannot read the bundle store, the token meter, or a routing profile, all
of which `buildContextStatus` needs.

Rather than fake that, the projection carries what the event log genuinely
supports — and one figure is **better** for it:

| figure | command plane | panel |
| --- | --- | --- |
| archived tokens | `Σ chars / 4` over archived text — **estimated** | `Σ compaction/summary.shadowedTokenCount` — **measured** |
| folds / roots | bundle store | EF's own marker in the summary body |
| recalls / searches | `tool/call` names | same |
| cost | routed profile + reported usage | shipped profile + accumulated usage, or `null` |
| mode | the live engine | the live engine, via a getter |

The archived-token disagreement is the honest one: the panel has the meter's own
number for the span each fold replaced, while the command can only price text.
Both are labelled with their basis, and they are allowed to differ because they
are derived differently.

### The mode is a GETTER, and that is load-bearing

`/context mode` switches the tier of a **running** session. A projection that
captured its mode at registration would leave the panel reporting the mode the
session started in — a displayed value disagreeing with reality. So the option is
a getter, and the view reports the live engine's mode.

A switch produces no session event, so the projection is not republished the
instant it happens: the panel is stale for at most one committed event, and never
permanently wrong. That tradeoff is recorded because it is observable.

---

## 2. The panel, and why there is no bundler

`client.js` is authored directly in DSH's client-module format:

```js
window.__ModuleLoader__.load({
  id: 'dsh-epistemic-fold',
  factory: (require) => { … return { apply, inject, name } },
})
```

The real sidebar plugin on this machine ships **1.1 MB of bundled client JS** in
that same wrapper, but the wrapper itself is plain — the bundler produces it, it
is not required by it. This panel needs `react` and `react/jsx-runtime` (both
provided by the host loader as shared externals) and nothing else, so a bundler
would add a build pipeline, a dependency tree, and a second artifact to keep in
sync, in exchange for minifying about 250 lines.

`scripts/build-plugin.mjs` therefore **copies** it into `lib/client.js` rather
than transpiling it — running it through the compiler would rewrite the shared
React imports into file paths the browser cannot resolve.

The package declares the face the way `dsh-client-modules` expects:

```jsonc
"exports": { "./client": { "default": "./lib/client.js" } },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] } }
```

### What it renders

Per the directive, the first version is deliberately small:

```
Epistemic Fold            economy
Archived history   Archived tokens   286k
                   Checkpoints now      30
Folds (lifetime)   Leaf folds           27
                   Root rebases          3
Retrieval          Recalls               8
                   Searches             12
Session            Cost (estimated)  ~0.0840
                   Priced with  deepseek-flash-2026-09
                   Provider tokens     1.5k
```

and an unknown figure renders **`—`**, never a zero. The footer states it
plainly: *"Observation only — this panel reads a client projection and never
enters the model context."*

The panel registers through `ctx.betterSidebar`, which a deployment may not have
mounted — the panel then simply does not exist rather than failing the client
load, the same conditional rule the host side follows for `ctx.tools` and
`ctx.commands`.

### It cannot enter model context

Not by promise but by construction: it reads a **client-side projection**. Nothing
in that path reaches a prompt, so the panel cannot grow the context it reports on
or invalidate a prefix cache. That is the directive's non-negotiable, and it is a
property of the data source rather than a rule a future edit could forget.

---

## 3. The control plane, unchanged from RC3

```
/context status        the text report
/context line          one-line form
/context mode          show the ladder
/context mode <tier>   switch tiers
```

No internal-parameter commands. A user touches three tiers; `retainRatio`,
`semanticMode` and `rootPolicy` stay in config, which is the directive's
"高级用户仍然可以配置 … 但那属于 config，不属于普通交互".

---

## 4. Verified

- **The client bundle loads under the real loader contract.** A test evaluates it
  against a simulated `window.__ModuleLoader__`, confirms the module id, `name`,
  `inject: ['betterSidebar']` and `apply`, then drives `apply()` against a fake
  service and asserts exactly one tab registers with a stable id and that the
  disposer works.
- **It renders, and unknown is `—`.** A minimal renderer invokes the component
  tree and asserts the full panel's text, and separately that an unknown cost
  produces an em dash and not `0.0000`.
- **The wire value is real.** In the real install, a session with one
  `context_search`, one `context_recall` and a `resume` header produces
  `{"recalls":1,"searches":1,"resumed":true,"cost":null,…}` — with `cost: null`
  rather than `0`, since nothing had been priced.
- **Control and observation are connected.** Driving `/context mode` through the
  real command registry leaves the projection reporting the engine's actual mode;
  when the switch was refused (the seam, on an unpatched build) the panel
  honestly stayed on `legacy`.

658 keyless tests pass, 22 skipped, typecheck clean.

---

## 5. State

```
Compression architecture  CLOSED
Recall correctness        CLOSED
Retrieval ergonomics      CLOSED
Product surface           SHIPPED   (three tiers + /context status)
Real DSH pluginization    DONE      (builds, mounts, folds, switches)
Sidebar panel             SHIPPED   (observation plane over the shared model)
route-level cost gate     OPEN
```

The tier's steadiness benefit remains a **HYPOTHESIS**. The directive's closing
point is that the panel is what makes it answerable in practice — `EpistemicSteady`
stops being a benchmark score and becomes something a user watches during a real
session — and that needs a real long session with the panel open, which is a
usage exercise rather than a test.

---

## 6. Files

| file | change |
| --- | --- |
| `client.js` | NEW — the Sidebar panel, hand-authored in the loader's format |
| `src/status-projection.ts` | NEW — the wire projection, a pure event fold |
| `scripts/build-plugin.mjs` | copies the client face verbatim into `lib/` |
| `src/plugin.ts` | registers the status projection with a LIVE mode getter |
| `package.json` | `exports["./client"]`, `dsh.client`, `client.js` in `files` |
| `tests/rc4-sidebar-panel.spec.ts` | NEW — 20 tests |
