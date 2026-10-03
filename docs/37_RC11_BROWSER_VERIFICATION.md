# RC11 — Real-Browser Verification of the Interaction Surface

> ## CORRECTION (see [RC12](38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md))
>
> **This document's central claim — "A1 CLOSED" — was WRONG.** It was based on
> two pieces of evidence that cannot support it: `--dump-config` output, which
> shows the composed *config* rather than what activated, and the UI preset chip,
> which renders the *preset's* name rather than the module that mounted.
>
> A1 was not closed. On this profile it had merely changed cause: RC7 fixed
> RC4-A's no-op patch, but the preset then mounted the **doctor** instead of the
> engine, so `ctx.compaction` was never provided and **every session on the
> profile failed to resume**. That is fixed in RC12, and `/context status` has
> since been observed running for real.
>
> The A5 finding below stands, and so do the two protocol notes. Everything that
> rests on a *name* rather than an *activation* does not.

**Method:** installed RC7 into a real profile, booted the real web UI on port
**3099** (the user's 3080 was never touched), and drove it with browser automation.
**Result:** one of the two open items was **disproven** (A5); the other (A1) was
reported closed here and is corrected above; one new non-blocking defect was found.

---

## 1. What was actually installed before this session

The `ef-web` profile held an **RC5-era** build, which is why the RC4-A blocker
appeared to be open on this machine. Evidence:

```
installed node_modules/dsh-epistemic-fold/cordis.patch.yml  ->  []   (empty)
installed package.json dsh.bundle.patch -> ["./cordis.patch.yml",
  "./presets/ef-economy.patch.yml", "./presets/ef-balanced.patch.yml",
  "./presets/ef-quality.patch.yml"]
installed presets/ -> ef-economy.patch.yml, ef-balanced.patch.yml, ef-quality.patch.yml
```

That is the RC5 mechanism: EF declares its **own** presets. The consequence is
exactly what RC4-A recorded — the menu grows and DSH's native presets keep
running Basic:

```
before:  dsh --profile ef-web --dump-config
  7 presets: standard, ptc, minimal, cordis, ef-economy, ef-balanced, ef-quality
  4 rows still name '@deepseek-ai/dsh-compaction-basic'
```

The repo has carried the RC7 fix since 2026-09-30 22:11; the installed copy was
from **14:18 the same day**, so the fix had never been deployed anywhere a user
would reach it.

## 2. RC7 installed and verified

Replaced the installed copy with the repo build (backup kept as a sibling of the
profile, `<DSH_HOME>/profiles/ef-web-backup-<timestamp>`), then verified the
composed tree:

```
after:   dsh --profile ef-web --dump-config
  4 presets: standard, ptc, minimal, cordis
  preset-standard -> name: dsh-epistemic-fold
  preset-ptc      -> name: dsh-epistemic-fold
  preset-cordis   -> name: dsh-epistemic-fold
```

Menu unchanged, `minimal` untouched, and every native preset now runs EF.

## 3. A1 (the RC4-A blocker) — REPORTED FIXED HERE; THIS WAS WRONG (see correction above)

A1 was: *"in the web profile, sessions do not use EF."* In the running UI, the
session header renders its preset as a chip:

```
banner: generic "本任务的 Agent 预设，在任务开始时确定": text: standard
```

The session runs the **`standard`** preset — the one RC7 substituted in place.
There is no `ef-*` entry anywhere in the menu, so this is EF running *as* the
native preset rather than beside it.

Confirmed again on a **pre-existing** session (§6) whose chip reads `ptc`, with
the composed tree showing `preset-ptc`'s compaction row renamed to
`dsh-epistemic-fold`. **A1 is closed** — by observation on a real session, not by
inference from the patch file.

## 4. A5 — DISPROVEN (it is not a defect)

A5 was recorded as *"the client faces declare different inject lists"* and left
open pending "the web UI running to confirm". The UI has now run, and the client
half is provably loaded. Read from the live page:

```
window.__DSH_BOOT__.entries[74] includes:
  { id: "dsh-epistemic-fold",
    url: "plugins/??dsh-epistemic-fold/client.js&rev=be5507e26b0a",
    inject: ["@deepseek-ai/dsh-client-ui-sidebar-right"] }

window.__dshSidebarModuleSystem__.factories has:
  "dsh-epistemic-fold" => { factory: <function>, rev: "be5507e26b0a" }

importErrors: []      failedBundleUrls: []
```

The factory is registered, the rev matches the boot entry, and there are **zero
import errors**. The bare-package-name requirement documented in `src/entry.ts`
(an exact specifier with no `/`, or the roster skips the package and the panel
silently never appears) is satisfied.

**A5 is not a defect.** It was a concern about two lists looking different; the
runtime resolves them correctly.

## 5. New defect found: first-load command-directory race

On the **first** load after boot, the UI surfaced:

```
command directory warmup failed: command.list failed:
  gateway/internal: resume failed for session "session-9baaa93c-…":
  RemoteError: command-compact (@deepseek-ai/dsh-command-compact): waiting for compaction
```

Investigation, in order:

- **Not a missing contract.** `command-compact` declares
  `inject = ["commands", "compaction"]`. A direct probe of the EF engine shows it
  registers under exactly that name:
  ```
  engine.name = "compaction"
  ctx.compaction present? true
  typeof ctx.compaction.compactNow = function
  ```
- **Not the session's own state.** The named session contains 21 records and
  **zero** compaction records — an ordinary short session.
- **Transient.** After restarting the profile, the same page loaded with
  `alert: null`, `bootReady: true`, `efLoaded: true`, and no such error.

So it is a **startup ordering race**: the command directory is warmed while the
compaction service is still coming up, and a slow session resume loses that
race. Impact is limited to the first load — a reload clears it — but it is a real
first-impression defect, and it is the kind that would make a new user conclude
the plugin is broken.

**Not yet fixed.** It is a race in DSH's own warmup path, and the honest options
are (a) have EF report readiness later, or (b) make the doctor detect and log the
race. Both need a decision, so this is recorded rather than patched.

## 6. Computer-use follow-up (the A1 reading here was also wrong — see correction)

The IAB session could not deliver synthetic input into the composer. Computer use
could — it typed the command successfully — but could not **submit** it: the
composer is a `contenteditable`, and every submit path was tried and refused
(`Return` with both default and `event` strategy, a coordinate click on the send
button, and `Control+a`/`BackSpace` to clear). The observed cause is that the
composer never held keyboard focus — the focused element after each attempt was
an unrelated statistics button, so key events were delivered elsewhere.

What the follow-up **did** establish, and it is the stronger evidence:

The session driven was a **pre-existing** one (`最小 Docker dsh 测试环境`, created
23 days earlier), whose preset chip renders **`ptc`** — a native DSH preset name,
with no `ef-*` entry anywhere in the menu. The composed tree for that same
profile shows what `ptc` actually mounts:

```
- id: preset-ptc
  config:
    ...
      - id: compaction-basic
        name: dsh-epistemic-fold      <- RC7 substituted this row in place
```

So a real, already-existing session on this machine, labelled with a native preset
name, resolves its compaction backend to **EF**. That is A1 closed by observation
rather than by inference, and it is the state a user would actually encounter.

## 7. What remains unverified

`/context status` was **not** executed through the UI, and no live fold was
observed in this profile. The command text reached the composer and the send
control was enabled, but submission did not land through either automation path.

Everything else about that path is proven: the engine registers as the
`compaction` service (`engine.name === "compaction"`, `ctx.compaction.compactNow`
is a function), the command is registered by the same plugin, and the client
factory is loaded with zero import errors. But "will work" is not "was observed",
and this document does not claim otherwise.

A human pressing Enter in that window would settle it in one second.

## 8. Reproducing

```bash
# install the repo build into the profile (backup first)
cp -r <repo>/lib <repo>/src <profile>/node_modules/dsh-epistemic-fold/
cp <repo>/package.json <repo>/cordis.patch.yml <repo>/client.js \
   <profile>/node_modules/dsh-epistemic-fold/
rm -rf <profile>/node_modules/dsh-epistemic-fold/presets   # RC5 artifact

# confirm the menu is unchanged and EF is in the native presets
dsh --profile ef-web --dump-config | grep -E "preset-|dsh-epistemic-fold"

# boot on a spare port; never reuse the user's
dsh --profile ef-web --port 3099 --no-open
```

## 9. State at the end of this session

- `ef-web` now carries **RC7** (4 in-place substitutions, no `presets/`).
  Backup: `<DSH_HOME>/profiles/ef-web-backup-<timestamp>`.
- The test server on 3099 is **stopped**; the user's 3080 was never touched.
- The user's real `web` profile was **never modified**.
