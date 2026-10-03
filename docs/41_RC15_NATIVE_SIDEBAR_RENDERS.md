# RC15 — The native sidebar panel renders

RC14 left the native half of the dual registration unverified and documented as
"the type registers, the body does not". That conclusion was wrong: it was
measured against a file that did not parse. This document records what the
defects actually were, how the `inject` requirement was *proved* rather than
inferred, and what was observed in a real browser.

## 1. First: the RC14b measurement was invalid

The instrumented `lib/client.js` installed for the RC14b trace was not
syntactically valid:

```
$ node -e "new Function(require('fs').readFileSync(SERVED,'utf8'))"
PARSE ERROR: Unexpected token 'catch'
```

The probe put `try {` before `const mount` and `} catch` after the
`tabs.register({...})` call, closing `mount`'s body early. A module that cannot
parse never runs `apply`, so the markers in that trace were served by a
*previous* revision the page still had cached.

The rule this yields is mechanical, not a matter of care:

> Before reading any instrumentation result, **fetch the served bytes and parse
> them**, and diff them against the file that was edited.

The entry URL is `/plugins/??dsh-epistemic-fold/client.js&rev=<rev>`, with
`<rev>` read from `__DSH_BOOT__.entries` in the page or from the boot HTML. An
install also needs **both** root `client.js` and `lib/client.js`:
`exports['./client']` serves `lib/client.js`, and `scripts/build-plugin.mjs`
copies one to the other.

## 2. The two real defects

Both are in `client.js`, and both were found only after the build was verified
clean.

### 2.1 `description` must be thunked copy, not a string

The native guide entry was registered as:

```js
guide: [{ id: NATIVE_ID, order: 60,
          title: () => STRINGS.tabTitle,
          description: STRINGS.tabDesc }]     // ← string
```

The contract calls it as a function on every render, so a language change needs
no re-registration (`ui-sidebar-right/lib/client.js`):

```js
const description = described ? entry.description?.() : void 0;
```

Passing the string threw `STRINGS.tabDesc is not a function`. The guide page is
the **doorway** to a tab type — it is where the entry is listed and picked — so
that throw took out the entire guide body. Observed in the DOM as:

```html
<div data-slot-error="sidebar.right.pane.tab"></div>
```

The fix is one character-class: `description: () => STRINGS.tabDesc`. The
better-sidebar registration already had it right, which is why that path never
showed the symptom.

### 2.2 `ctx.slots` must be declared in an `inject` list

EF's client module exported `{ apply, name }` and reached for `ctx.slots`
directly. Cordis refuses that property unless the service is declared:

```
cannot get property "slots" without inject
```

This failure is **shaped to mislead**. The tab TYPE registration runs first and
succeeds, so the chip appears and the tab opens; the BODY seat then throws, the
renderer's boundary catches it, and the pane reads
"这类内容还没有可用的查看方式。" (no available way to view this content). A
registered type with a missing body is a *legitimate* state — it is what you see
when the owning plugin was unmounted — so the UI reports it as one and the real
cause never surfaces.

The fix is to export the dependency:

```js
return { apply, name: 'epistemic-fold', inject: ['slots'] }
```

## 3. Proving the `inject` requirement, rather than inferring it

The earlier attempt to establish this was wrong twice: first it provided `slots`
at the **root**, where any descendant can read it (so the undeclared access
succeeded and the requirement looked absent), and then it checked only for a
throw without checking the resolved value.

The faithful shape is two **sibling** plugin fibers under one root, which is how
the client module loader creates each entry, with the provider holding `slots`
on its own fiber:

```
NO inject      : threw="cannot get property \"slots\" without inject" resolved=null
inject [slots] : threw=null resolved={"marker":"SLOTS"}
```

That is the experiment the fix rests on. It also settles the *other* half of the
question, which is why the module does not simply declare everything:

- `slots` is provided by `@deepseek-ai/dsh-client-ui-renderer`, the shell that
  mounts this module at all, so it cannot be absent where this code runs.
  Declaring it is safe.
- `betterSidebar` belongs to a third-party plugin a deployment may not have. A
  declared `inject: ['betterSidebar']` holds the entry pending forever and was
  measured to fail the **whole web boot**, not just hide the panel. It stays on
  the optional idiom, `ctx.inject(['betterSidebar'], cb)`.

Two tests had over-generalized the second fact into "the module declares NO hard
inject". They now assert the distinction instead: `betterSidebar` must not be
hard-injected, and `slots` must be.

## 4. What was observed

With both fixes deployed, in a real browser, against `ef-web`:

**Native-only** (better-sidebar disabled via a `--patch` overlay):

- The guide page lists EF's entry: `kind: "dsh-epistemic-fold"`, with its title
  and description.
- Picking it opens a tab titled "Epistemic Fold".
- The body renders the full status panel: pressure, window, archived tokens,
  checkpoints, leaf folds, root rebases, recalls, searches, estimated cost,
  priced-with model, provider tokens, and the observation-only footnote.

**better-sidebar enabled** (the normal configuration):

- The EF tab is present in the strip and the same panel renders. No regression.

The only remaining `data-slot-error` in either configuration is
`sidebar.footer.action`, which belongs to a different plugin and predates this
work.

## 5. Verification performed

- Served bytes fetched and parsed before each reading; `__DSH_BOOT__` rev
  compared against the file on disk.
- `client.js` parse-checked (`new Function`) after every edit.
- `tests/rc4-sidebar-panel.spec.ts` and `tests/rc3-plugin-packaging.spec.ts`
  updated to pin the `inject` distinction; 37 tests pass in those two files.
- Full suite: **739 passed, 23 skipped**.
- The user's DSH on port 3080 was never touched; all experiments used port 3099
  and were stopped afterwards.

## 6. Lesson

Three instrumentation errors in one investigation, and the third was the first
one repeating: an edit that never reached the served file. Care did not catch
them; a mechanical check did. The check is cheap and belongs in the loop:

```sh
# what the browser will actually execute
curl -s "$ENTRY_URL" -o served.js && node -e "new Function(require('fs').readFileSync('served.js','utf8'))"
```

A silent failure that the UI reports as a *legitimate* state — a type with no
body, a plugin that was unmounted — is the most expensive kind to diagnose,
because every layer between the throw and the screen has a good reason to say
nothing.
