# RC3 — Real DSH Pluginization

Baseline: `main@d05ba05` (RC2.1 merged).
Scope: make EF a real, loadable DSH plugin, and correct the earlier overclaim.

> **One-line result.** EF is now a **real DSH plugin**: it builds to loadable JS,
> declares a bundle patch, mounts into a real local DSH 0.2.0-rc.2 profile, and
> **provably folds there** — two compaction transactions committed, `EF1 L cp:…`
> markers on the real surface, durable bundles on disk. `/context mode
> economy|balanced|quality` switches the running engine in that real host. The
> earlier claim that RC2's comparison ran "in DSH" was **wrong** and is corrected
> in place.

---

## 1. The correction first

RC2's report said the real-task comparison ran "across the four modes" in DSH and
that the driver "mounts the real plugin". What actually happened: a hand-built
`new Context()` with services mounted by hand, then `new EpistemicFoldPlugin(…)`.
The provider and the tools were real; the **host was not DSH**.

That was the third instance of the same error in this project — RC1.2.1's "Basic"
arm that was EF, RC2.1's "legacy" arm that was EF-legacy, and this. All three
claimed more than was done. `docs/24` and `docs/25` carry the correction in
place, and `eval/real-task/driver.ts`'s header now says it is a harness.

What made the correction *possible* is the same thing that made it *necessary*:
once EF actually mounted in DSH, the difference between the two was measurable
rather than rhetorical — see §3.

---

## 2. What a real DSH plugin needs

Read off the machine's actual install (`D:/dsh`, reached as `~/.dsh`) and a real
third-party plugin in it (`dsh-contextvm`):

| requirement | RC2.1 state | now |
| --- | --- | --- |
| `main` is loadable JS | `src/index.ts` — **Node cannot execute it** | `lib/entry.js` |
| a build step producing `lib/` | none | `scripts/build-plugin.mjs` |
| `.` export is the plugin | the library face | the plugin entry |
| `dsh.bundle.patch` declared | absent | `cordis.patch.yml` |
| patch replaces `compaction-basic` | n/a | `disabled: true` |

The build transpiles `src/**/*.ts` to `lib/**/*.js` with
`rewriteRelativeImportExtensions`, so the source's `./engine.ts` becomes
`./engine.js`. No bundling and no `.d.ts`: the runtime needs plain JS, and the
TypeScript source stays the single source of truth rather than a second artifact
that can drift.

The patch disables `compaction-basic` because **EF owns `ctx.compaction`** and
Cordis allows one registration per service — with both live, the profile fails to
boot.

### The tiers cannot be the shipped default

Every tier selects `framingMode: system-dedup`, which requires the
`frameCheckpoint` seam. **Real DSH 0.2.0-rc.2 does not have it**: framing is
applied by a module-local `frameSummary` call, `this.frameCheckpoint` is never
invoked, and `BasicCompactionEngine.prototype.frameCheckpoint` is `undefined`. So
the patch ships `mode: legacy` — the one configuration needing no seam — and a
tier is selected either in `config` on a seam-carrying build or at runtime with
`/context mode`.

I verified all of this against the real install, including that the documented
remedy does **not** apply as written: `scripts/apply-framing-seam.mjs` patches
`src/` and `lib/types/`, but a real install ships only `lib/*.js`, so the script
reports "0 applied" there. A real deployment needs a different remedy (an
upstream seam, or a patch aimed at the built artifact).

---

## 3. The bug only a real host could find

The first real boot failed:

```
epistemic-fold (dsh-epistemic-fold): Error: cannot get property "tools" without inject
    at registerRecallTools (lib/tools.js:91:31)
```

`ctx.get('tools')` **throws** in Cordis when `tools` is not declared in `inject`.
The correct idiom for an optional service is `ctx.inject(['tools'], cb)`, which
runs the callback only once the service exists.

**Every test harness pre-mounted a `ToolRuntime`**, so the broken probe was
unreachable from the test suite. This is precisely the class of defect a harness
cannot see, and it is the concrete argument for the whole stage: the difference
between "works under a hand-built context" and "loads in DSH" was one real
failure, not a formality.

Two more things the real host settled that the harness had left ambiguous:

- **`ctx.inject` is asynchronous.** A child fiber starts after the constructor
  returns, so checking for the registered command immediately finds nothing. My
  own first probe of this concluded wrongly that `/context` was unregistered; it
  registers correctly, and the packaging test now waits.
- **The headless profile's window is 1,000,000 tokens with 256,000 reserved**, so
  the default threshold is 50,000 — a short task never reaches it. Forcing a fold
  needed a scaled threshold, not a longer prompt.

---

## 4. Proof it works in the real host

### It folds

With a scaled threshold, a real `dsh --profile ef-dev "<task>"` run produced:

```
[EF-PROBE] CALLING compactRegion 8..10
[EF-PROBE] compactRegion RETURNED shadowed=3
[EF-PROBE] CALLING compactRegion 18..20
[EF-PROBE] compactRegion RETURNED shadowed=2
```

and on disk, in the real session log and the real bundle store:

```
compaction events: {"compaction/start":2,"compaction/summary":2,"compaction/end":2}
EF surface markers: 4 × "EF1 L cp:84282e00-…", "EF1 L cp:311766c4-…"
bundles: 7 × bundle-*.json + commit-*.json under .epistemic-fold/bundles/session-…/
```

That is EF performing real compaction in a real DSH session: durable
transactions, checkpoint markers on the model-visible surface, and hash-verified
bundles on disk.

### The control plane works

Through the real command registry in the real host:

```
BOOT   mode=economy semantic=none retain=0.16
>>> /context mode balanced => success | mode economy -> balanced
>>> /context mode quality  => success | mode balanced -> quality
>>> /context status        => success | context mode: quality
AFTER  mode=quality semantic=rationale retain=0.24
```

The switch moves the **resolved policy**, not just the label. And the framing
guard does its job: on an unpatched build, `/context mode economy` from `legacy`
is refused with the reason rather than half-applied.

### The environment was left as found

The seam patch to the real `dsh-compaction-basic` was **verification only** and
has been reverted (`frameCheckpoint` is `undefined` again). The test profile
`~/.dsh/profiles/ef-dev` remains, because it is the artefact that makes the claim
reproducible.

---

## 5. Command plane vs Sidebar

RC3's directive separates **command = control** from **Sidebar = observation**.
The command half is done:

```
/context status     the text report (unchanged)
/context line       one-line form
/context mode       show the ladder
/context mode <t>   switch tiers
```

Deliberately **no** internal-parameter commands. A user touches three tiers;
`retainRatio`, `semanticMode`, `rootPolicy` stay in config.

### The Sidebar half needs client code, and that is a scope decision

I checked rather than assumed. `@deepseek-ai/dsh-client-ui-sidebar` is a
**browser-only** package: its host entry is `export function apply(): void` with
the comment "Provides no host-side behavior". The real sidebar plugin on this
machine (`dsh-better-sidebar`) ships a **1.1 MB bundled `lib/client.js`** to
register its tabs.

So a sidebar panel **cannot** be done host-only or config-only. It needs a client
bundle, and the honest options are:

1. **Depend on `dsh-better-sidebar`'s registration service** — it explicitly
   "exposes a service other plugins use to register sidebar tabs". Smallest
   client surface, but couples EF to a third-party plugin.
2. **Ship EF's own client entry** — self-contained, but EF grows a UI build
   pipeline and a browser artifact, which is the thing the directive warns
   against ("避免 EF 自己长成一套复杂 UI 系统").
3. **Host-side status projection only, no panel** — register a projection with a
   `wire` view and let a generic renderer show it, if one exists.

The data contract for any of these is already in place and is the part that
matters: `buildContextStatus()` is a pure function, and `/context status` and a
panel renderer would consume the **same** model rather than the panel parsing the
command's text. That was the directive's central point, and it holds regardless of
which option is chosen.

I did not pick one: it changes what EF ships (a browser artifact) and adds a
dependency, and that is the user's call rather than a default I should assume.

---

## 6. State after RC3

```
Compression architecture  CLOSED
Recall correctness        CLOSED
Retrieval ergonomics      CLOSED
Product surface           SHIPPED   (three tiers + /context status)
Real DSH pluginization    DONE      (builds, mounts, folds, switches)
Sidebar panel             OPEN      (needs a client bundle — scope decision)
route-level cost gate     OPEN
```

---

## 7. Files

| file | change |
| --- | --- |
| `scripts/build-plugin.mjs` | NEW — transpiles `src/` to loadable `lib/` |
| `src/entry.ts` | NEW — the loader-facing entry (`name`/`inject`/`Config`/default) |
| `cordis.patch.yml` | NEW — the bundle patch; inserts EF, disables `compaction-basic` |
| `package.json` | `main` → `lib/entry.js`; `.` → plugin entry; `dsh.bundle`; build script |
| `src/plugin.ts` | **real bug fix**: `ctx.inject(['tools'])` instead of `ctx.get('tools')` |
| `src/engine.ts` | `setMode()`; `efConfig` became a getter over mutable policy |
| `src/command.ts` | `/context mode`; `setMode` in the deps |
| `tests/rc3-plugin-packaging.spec.ts` | NEW — 11 tests pinning the packaging contract |
| `tests/rc2-status.spec.ts` | 7 tests for the control plane |
| `docs/24`, `docs/25` | the "measured in DSH" overclaim corrected in place |

638 keyless tests pass, 22 skipped, typecheck clean.
