# RC12 — The Preset Backend Mounted the Doctor

**Severity:** the profile was completely unusable — every session failed to resume.
**Introduced:** RC7 (`5e68f98`). **Fixed:** this commit.
**Found by:** the user, from the error text.

---

## 1. The symptom

Every session on the `ef-web` profile failed to resume:

```
command.list failed: gateway/internal: resume failed for session "…":
RemoteError: command-compact (@deepseek-ai/dsh-command-compact): waiting for compaction
```

The message reads like a compaction is stuck. It is not. The host-side diagnostic
template is:

```
<row id> (<row name>): waiting for <missing service>
```

So `command-compact` was **waiting for the `compaction` service to exist**, and it
never appeared. The whole preset failed to mount, which is why *every* session
failed and not just one.

## 2. Root cause

RC7 changed what the bare package name exports. In `src/entry.ts`:

| | before RC7 | after RC7 |
|---|---|---|
| `import 'dsh-epistemic-fold'` | `EpistemicFoldPlugin` | `epistemic-fold-doctor` |
| injects | `llm, tokenMeter, sessions, sessionProjections` | `loader` |
| provides | the `compaction` service (via the engine) | **nothing** |

That change is correct and necessary: the client roster
(`exactPackageSpecifier` in `dsh-client-modules`) only recognises an exact
package specifier with no `/`, so the bare name has to be occupied for the
package's browser half to reach the UI. `src/entry.ts` documents this.

But the preset generator kept emitting the bare name for the row that replaces
`compaction-basic`:

```yaml
- id: compaction-basic
  name: dsh-epistemic-fold        # <- resolves to the DOCTOR
```

So each preset's compaction group mounted an observation-only module. With no
`compaction` provider, `command-compact` stayed pending forever and the mount
failed.

Verified directly, from the profile's own node_modules:

```
dsh-epistemic-fold/plugin -> EpistemicFoldPlugin   inject: [llm, tokenMeter, sessions, sessionProjections]
dsh-epistemic-fold        -> epistemic-fold-doctor inject: [loader]
```

## 3. Why three separate checks all missed it

Every check compared **names**; none observed **behaviour**.

| check | why it passed |
|---|---|
| `rc7-inplace-drift:171` | asserted the row named `dsh-epistemic-fold` — exactly what the bug emitted. **The test protected the defect.** |
| `rc3-plugin-packaging:137` | asserted the bare name appeared **4 times** — it counted the three broken rows as correct. |
| `dsh --profile ef-web --dump-config` | prints the composed CONFIG TREE. The config was right; the module behind it was wrong. It cannot see activation. |
| The UI preset chip | renders the **preset's** name (`ptc`, `standard`), not the module that mounted. Identical either way. |

The generator's own sanity check had the same shape: it asserted
`out.some(line => line.includes('name: dsh-epistemic-fold'))`, which the doctor
row satisfies.

## 4. The fix

**Generator** (`scripts/generate-presets.mjs`): the substitution row now names
the plugin subpath, via a named constant:

```js
const PLUGIN_SPECIFIER = 'dsh-epistemic-fold/plugin'
```

The top-level doctor row keeps the bare name — that is what the client roster
needs. The generator's sanity check now asserts the exact specifier rather than a
substring that the doctor row could satisfy.

Subpath specifiers are supported by the loader; DSH's own shipped presets use one
(`@deepseek-ai/dsh-plugin-manager/tools` in `standard`, `ptc` and `cordis`). The
bare-name rule belongs to the client roster, a different mechanism that never
reads this row.

**Two tests corrected**, because both encoded the bug:
`rc7-inplace-drift` now asserts `dsh-epistemic-fold/plugin`, and
`rc3-plugin-packaging` counts one bare name and three plugin subpaths.

## 5. The test that would have caught it

`tests/preset-backend-specifier.spec.ts` — five assertions that check the
*property* rather than the name:

1. the backend names the plugin subpath, not the bare package name;
2. that specifier **resolves** through the package's exports map;
3. the named module **is the plugin** (injects `llm`, `tokenMeter`, `sessions`)
   and the bare name **is the doctor** — this is the behavioural check none of the
   others performed;
4. exactly one row keeps the bare name, and it is the doctor row, so the client
   roster still finds the package;
5. all three presets target the same specifier, so the breakage cannot become
   preset-specific.

**Sabotage-verified:** reverting the patch to the bare name makes 4 of the 5
fail. The one that still passes is "resolves from a real install" — precisely the
class of name-only check that let this through.

## 6. Live verification

After regenerating, installing into `ef-web` and restarting (port 3099, PID
44984; the user's 3080 was never touched):

- the error is absent from the instance log (0 occurrences);
- the previously-failing session renders, with **no error banner**;
- its preset chip now reads **`PTC 模式`** (it read the bare `ptc` before — the
  preset had not been activating);
- `/context status` executed and returned EF's own report:

```
context mode: economy   Lowest cost; quality measured at parity with Basic
current context:  pressure 111533 tokens   window 1000000 tokens   occupancy 11.2%
                  fold threshold 678464 tokens
archived history: archived tokens ~0 (estimated)   checkpoints num 0
retrieval:        recalls 0   searches 0
```

`context mode: economy` is the decisive line: the EF engine is running and
reporting its own mode. `checkpoints num 0` is expected rather than a fault — the
session is at 3.1M tokens against a 678K fold threshold on a 1M window.

**This also settles what RC11 could not.** `/context status` had never been
observed executing; it now has, in the real UI.

## 7. Correction to RC11

`docs/37_RC11_BROWSER_VERIFICATION.md` claimed **"A1 CLOSED"** on evidence that
could not support it: `--dump-config` output (config, not activation) and the
preset chip (preset name, not module). A1 was **not** closed; on this profile it
had merely changed cause — from RC4-A's "the top-level patch is a no-op" to "the
preset mounts the wrong module". That document now says so.

The lesson is narrow and worth keeping: **a config tree and a preset chip are
both names. Neither tells you what mounted.**
