# The deployment chain — GitHub to a running DSH

Status: OPERATIONAL. Every command and path below was read off this machine's
working install (`D:/dsh/profiles/ef-web`, DSH `0.2.0-rc.2`) rather than
reconstructed from intent. Where a step has a failure mode, the failure mode is
stated with the symptom you would actually see.

This document describes **how the code gets from the repository to a session**.
It does not restate the design (`docs/31`), the history (`docs/26`), or the full
feature surface (`README.md`). It exists because those three answer "what" and
"why", and the question that keeps coming up is "which file do I change, and how
do I know it took effect".

## The chain in one line

> Source in `src/` → **build** emits `lib/` → **generator** rewrites DSH's own
> presets into `cordis.patch.yml` → **profile** declares the package and its
> bundle order → `dsh --profile <name>` boots → the patch swaps EF in as the
> compaction backend of DSH's own presets, and the user's UI does not change.

## 1. Source

`orangeofcarl0-sys/dsh-epistemic-fold`. The authoritative content is `src/**/*.ts`
plus one hand-written browser file at the repository root, `client.js`.

Two halves ship, and they are mounted by different mechanisms:

| half | entry | mounted by |
| --- | --- | --- |
| host | `lib/plugin.js` (`./plugin`) | a row **inside each preset's** compaction group |
| host | `lib/doctor.js` (`./doctor`) | a row at the **top level**, always |
| browser | `lib/client.js` (`./client`) | the client module roster, by **bare package name** |

## 2. Build

```bash
npm run build          # scripts/build-plugin.mjs
```

`src/**/*.ts` → `lib/**/*.js`, one file per file, no bundling. Two details
matter operationally:

- **`client.js` is copied, not compiled.** It is already in the loader's
  `window.__ModuleLoader__.load({...})` format and imports only React, which the
  host provides. Shipping it through the compiler would rewrite those shared
  imports into paths the browser cannot resolve.
- **The root `client.js` is the source; `lib/client.js` is what is served.**
  `exports['./client']` points at `lib/client.js`. Editing only the root file
  changes nothing the browser sees until the build runs. This exact mistake
  produced a wrong conclusion once (`docs/40` §4) — see §7.

`npm run prepare` (which npm runs on install) chains the build and the
generator below, so a fresh install cannot ship a stale `lib/` or a stale patch.

## 3. Generate the substitution rows

```bash
node scripts/generate-presets.mjs [--dsh <path>] [--mode <tier>]
```

DSH ships agent presets (`standard`, `ptc`, `cordis`, `minimal`) whose
compaction group names `compaction-basic`. EF replaces **that one row** with
`dsh-epistemic-fold/plugin`, inside each preset's existing group, leaving the
group's `isolate:` realm and every other row untouched.

Why the whole `config` is restated: the Loader can only address rows that have
`group: true` and an array `config`. A preset's `config` is an object holding
`plugins`, so nested ids are unaddressable and a patch cannot rename a row. The
preset's entire `config` must therefore be written out — which makes this block
**version-specific**: it mirrors the preset rows of the DSH it was generated
from.

The generator reads *your installed DSH*, so the rows mirror reality instead of
being a hand-copy that rots. Re-run it after upgrading DSH.

`minimal` is deliberately not touched: it declares no compaction group, so there
is nothing to substitute, and it stays exactly as DSH ships it.

### Why the specifier is `dsh-epistemic-fold/plugin`

The bare name `dsh-epistemic-fold` mounts the **doctor**, not the plugin
(`src/entry.ts`). This is load-bearing and not obvious: the client module system
finds a package's browser half by scanning the loader for a row whose `name` is
an **exact package specifier** — a bare name, no `/`. A row named with a subpath
is skipped, the package's `client.js` never reaches the browser, and the Sidebar
panel silently never appears. So the bare name must exist, and it must be
something always-mounted and harmless: the doctor, which provides no service and
holds no state.

That defect is `docs/38`. It is worth knowing because its symptom was *absence*:
nothing errored, the panel simply was not there.

## 4. Wire it into a profile

In `<DSH_HOME>/profiles/<name>/package.json` (here: `D:/dsh/profiles/ef-web`,
and `~/.dsh` is a symlink to `D:/dsh`):

```jsonc
{
  "dependencies": { "dsh-epistemic-fold": "file:/path/to/dsh-epistemic-fold" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"        // ← must come AFTER dsh-web-app
      ]
    }
  }
}
```

Then, in the profile directory:

```bash
pnpm install
```

**Bundle order is a correctness requirement, not a preference.** The
substitution patch overrides rows that `@deepseek-ai/dsh-web-app` declares. A
bundle listed before it runs its patch before those rows exist, finds nothing,
and the patch is skipped.

## 5. Boot

```bash
dsh --profile ef-web
```

The profile's own `cordis.yml` is an empty entry list; the tree is composed as
patches — each bundle in `dsh.profile.bundles`, then the profile's
`cordis.patch.yml`, then any `--patch` overlays. EF's bundle patch is applied in
that sequence.

## 6. Verify it actually landed

This is the step that separates "it booted" from "it is running EF", and it is
not optional: **every failure mode in this chain is silent.** A missed patch
only warns and is skipped; a subpath-named row is skipped without a word; a
`client.js` that failed to parse produces no error, just a missing panel.

### What the doctor does and does not make visible

The top-level row always mounts and, ~5 s after boot, audits the preset registry
(`src/preset-self-check.ts`). It emits one of two messages:

```
[epistemic-fold] substitution active in 3 preset(s): standard, ptc, cordis
```

```
[epistemic-fold] SUBSTITUTION DID NOT LAND: no agent preset names "dsh-epistemic-fold", so
sessions are running native Basic while this package is installed. Two causes, in order of
likelihood: (1) this DSH build's preset rows changed … re-run
`node scripts/generate-presets.mjs` …; (2) this package is listed BEFORE
@deepseek-ai/dsh-web-app in the profile's bundle order …
```

**Be aware of where those messages go, because it changes how you verify.** They
are written through `ctx.logger`, and cordis's logger has no default console
exporter — its built-in sink buffers in memory (`LoggerService`, `bufferSize:
1000`). In a `dsh web` boot, neither line reaches stdout. Measured:

```
$ dsh --profile ef-web --port 3098 --no-open > boot.log 2>&1
$ grep epistemic-fold boot.log        # no output
```

`dsh-app-boot` installs one exporter, but it captures only `warn` and `error`,
and only to attach them to a thrown `StartupError`. So:

- The **failure** message is a `logger.error`. It is not printed on a normal
  boot either, but it does ride along on a startup failure — which is when you
  would be reading logs anyway.
- The **success** message is `logger.info` and is, in practice, **not observable
  in a web boot.** Do not plan on seeing it.

That is a real limitation of the current check, not a property to rely on. The
doctor's value is that it *fails loudly rather than silently reverting* — it
converts a missed substitution into an error on the startup-failure path, where
a user is already looking. It does not give you a green light on stdout.

### Verifying a healthy install, in practice

Since the success line is not printed, verify from the surfaces instead. All
three read the same underlying facts:

**1. The composition actually happened** — read the patch's own claim from the
repository:

```bash
grep -c "name: dsh-epistemic-fold/plugin" cordis.patch.yml   # → 3
grep -n "id: preset-" cordis.patch.yml                        # standard, ptc, cordis
```

Three rows, one per substituted preset, and `minimal` absent. `tests/rc7-inplace-drift.spec.ts`
fails when this block and the installed DSH's own presets disagree.

**2. The session is running EF, not Basic** — run `/context status` in a session
under `standard`, `ptc`, or `cordis`; it reports the mode, current context,
archived history, checkpoints, folds and recall activity. `/context mode
economy|balanced|quality` selects the tier at runtime. This is the model-side
surface, and it is where a wrong backend shows up first.

**3. The browser got the build you made** — in the page console:

```js
__DSH_BOOT__.entries.find(r => r.id === 'dsh-epistemic-fold').rev
```

Compare that `rev` against the file you built. This is the check that catches a
stale `lib/client.js`, and it is the one to reach for when the Sidebar panel is
missing (see §7).

The Sidebar panel itself is the fourth surface — the client-side projection,
read through `useProjection` from the same status model `/context status`
renders, so it cannot enter the model context.

The doctor cannot report on folds (it is observation-only — no service, no
projection, no state), so it cannot reproduce the RC4-A defect of a mounted EF
reporting folds it never performed. Its whole subject is whether EF is
*installed*.

## 7. When the panel is missing, verify the served bytes first

The single most expensive mistake in this project's history was reading an
instrumentation result from a file the browser never executed. Three times, all
in one investigation (`docs/41` §6).

The check is mechanical and cheap:

```bash
# the URL the page will actually fetch, with <rev> from the boot HTML or
# window.__DSH_BOOT__.entries
curl -s "$ENTRY_URL" -o served.js
node -e "new Function(require('fs').readFileSync('served.js','utf8'))"   # must not throw
diff served.js client.js                                                  # must be empty
```

An install needs **both** root `client.js` and `lib/client.js`. A file that does
not parse never reaches `apply`, so every marker in it is inert and any
conclusion drawn from it is about a previous revision the page still had cached.

## 8. Standing aside

To get native Basic back without uninstalling, set `mode: basic` in the
package's config. EF then delegates folds to a byte-identical Basic backend and
registers **no** EF surface at all — no projection, no Sidebar panel, no
`/context`, no recall tools. This is a supported configuration, not a
degraded one.

## 9. The chain as a checklist

| # | Step | Command / file | Failure symptom if skipped |
| --- | --- | --- | --- |
| 1 | edit source | `src/**/*.ts`, `client.js` | — |
| 2 | build | `npm run build` | browser serves the previous revision |
| 3 | generate rows | `node scripts/generate-presets.mjs` | doctor raises `SUBSTITUTION DID NOT LAND` |
| 4 | declare dependency | profile `package.json` → `dependencies` | package not resolvable |
| 5 | order the bundle | profile `package.json` → `dsh.profile.bundles` | patch finds no rows; same doctor error |
| 6 | install | `pnpm install` (in the profile) | stale `lib/` |
| 7 | boot | `dsh --profile <name>` | — |
| 8 | verify | `/context status`, Sidebar panel, `__DSH_BOOT__` rev | silent: Basic runs, or the panel is absent |

Steps 3 and 5 fail the same way and produce the same message, so the message
names both causes rather than guessing. Note that step 8's doctor message is
**not** printed on a healthy web boot (§6) — the three surfaces are what you
actually check.
