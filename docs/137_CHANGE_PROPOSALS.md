# 137 — Detailed change proposals, re-confirmed

`docs/136` gave the shape. This gives the concrete edits, and re-confirms every claim in `docs/133-135`
against the tree rather than against the auditors' summaries. **Three claims did not survive.**

## 0. Corrections to the audits, from re-verification

### 0a. "`eval/` is outside every tsconfig" — FALSE as stated, and the real problem is worse

`tsconfig.eval.json` exists and includes `eval/**/*.ts` and `bench/**/*.ts`. CI runs it:

```
package.json   typecheck       = tsc -p tsconfig.json          src + tests only
               typecheck:eval  = tsc -p tsconfig.eval.json     eval + bench
               typecheck:all   = all three, chained
.github/workflows/ci.yml   run: npm run typecheck:client
                           run: npm run typecheck:eval
```

So `eval/` IS checked — **by CI, and only by CI.** The default local command does not cover it, which is
why errors accumulate there unseen.

### 0b. Running it changes the picture completely

```
tsc -p tsconfig.json      2 errors, both in tests/memory-readme.spec.ts   (pre-existing)
tsc -p tsconfig.eval.json 6 errors, ALL previously unreported
```

```
eval/lhtb/watchdog.ts(272,29)      Cannot find name 'readFileSync'               16d8da4  MINE
eval/lhtb/watchdog.ts(288,78)      'cwd' does not exist in type                 16d8da4  MINE
eval/tau2/bridge-host.ts(753,67)   number not assignable to SessionSeq          f6354a7  not mine
eval/tau2/bridge-host.ts(780,67)   number not assignable to SessionSeq          f6354a7  not mine
eval/tau2/bridge-host.ts(1954,5)   'lastLeafDecision' does not exist in Telemetry 08b3b5e  MINE
eval/tau2/bridge-host.ts(2120,41)  Property 'ctx' is protected                  08b3b5e  MINE
```

**Four of the six are mine, from two commits this session.** `16d8da4` (the watchdog restart work) and
`08b3b5e` (the memory-bench work). Both were reported as verified at the time, because I ran
`tsc -p tsconfig.json` and — in several rounds — filtered its output with `Select-String`.

**So the "ghost key" `lastLeafDecision` is not a pre-existing drift. I introduced it**, by adding the
field to the bridge's telemetry object and never declaring it in the `Telemetry` interface. The
auditor found the symptom; the cause is mine.

### 0c. The four ghost whitelist keys — CONFIRMED, and one needs care

`run_cell.py:510-518` whitelists 27 keys. Measured occurrences in `bridge-host.ts`:

```
leafAdmission       0    ghost
postLeafRegime      0    ghost
foldReachability    0    ghost
thresholdTokens     3    real, but only nested inside `compactBudget`
```

So three are hard ghosts and the fourth is a nesting mistake: `telemetry.get('thresholdTokens')` is
`None` because the value lives at `compactBudget.thresholdTokens`.

### 0d. The other claims, re-confirmed by direct read

| claim | verdict |
|---|---|
| `lastLeafDecision` declared nowhere in the interface | CONFIRMED (3 occurrences, none a declaration) |
| `preset.ts:229-230` says "No LLM call for a checkpoint" above `semanticMode: 'rationale'` | CONFIRMED |
| `fold-telemetry.ts` cites `RATIONALE_MAX_TOKENS` | CONFIRMED, and `src/` no longer defines it |
| `ENGINE_DEFAULTS` hardcodes `800`; `DEFAULT_RATIONALE_HINT_TOKENS` is not exported | CONFIRMED |
| one cycle `policy.ts` <-> `preset.ts` | not re-verified here |
| 366 specifier edits for the move | not re-verified here |

## 1. Proposal A — make the eval layer type-checked, and fix what that reveals

**Why first:** it is four real errors, two of them mine, and it is the gate that would have caught the
other three proposals' mistakes.

**Edits:**

1. `eval/lhtb/watchdog.ts:272` — `readFileSync` is used but not imported. Add it to the existing
   `node:fs` import.
2. `eval/lhtb/watchdog.ts:288` — `execFileSync` is passed `{ cwd }`, which is not in the inferred
   options type. Widen the call's options object or the helper's signature.
3. `eval/tau2/bridge-host.ts:1954` — declare `readonly lastLeafDecision: string | null` in the
   `Telemetry` interface (near `lastCompactionError`). This is the one that makes the field real.
4. `eval/tau2/bridge-host.ts:2120` — `(engine as unknown as { ctx?: unknown }).ctx` reaches a
   `protected` member. Either add a public accessor on the engine for the identity comparison, or keep
   the cast but go through a typed helper so the escape is stated once.
5. `eval/tau2/bridge-host.ts:753,780` — NOT mine; `rotateTurn`/`openTurn` take `number` where
   `SessionSeq` is expected. Fix in the same pass, but record it as pre-existing.
6. `package.json` — make the default `typecheck` run all three, or add a `pretest` hook. **This is the
   edit that stops the recurrence**, and it is one line.

**Verification:** `npm run typecheck:all` exits 0 apart from the two known `memory-readme` errors;
`npm test` unchanged.

## 2. Proposal B — delete the ghost keys and correct the stale comments

**Why:** three whitelist entries have never carried a value, and the comments misdescribe the code.

**Edits:**

1. `eval/memory/run_cell.py:510-518` — drop `leafAdmission`, `postLeafRegime`, `foldReachability`.
   Replace `thresholdTokens` with a read of `compactBudget.thresholdTokens`, or drop it as redundant
   with `compactBudget`. **Then correct the comment at :505-509**, which currently claims those keys are
   the ones that say WHY a fold declined — the claim that made me widen the list.
2. `src/preset.ts:228-232` — the comment says "No LLM call for a checkpoint" above
   `semanticMode: 'rationale'`. Rewrite it to say what is true: every tier carries the digest;
   `semanticMode: 'none'` remains an explicit zero-LLM choice that no tier selects.
3. `src/preset.ts:253-255` — says the rungs differ ONLY by retention. They now differ by
   `rationaleHintTokens` 400/800/1600 as well. Rewrite.
4. `src/fold-telemetry.ts:93` — cites `RATIONALE_MAX_TOKENS = 400`, a constant deleted in `347dbd3`.
   Point it at `rationaleOutputFor` and `rationaleHintTokens` instead.
5. `src/engine.ts:107-147` — two stacked JSDoc blocks for the deleted constant. Collapse to one.

**Verification:** re-run the 252K quality cell and confirm `rationaleFailures = 0` and the artifact no
longer carries three permanent nulls.

## 3. Proposal C — the EF key table, scoped to M

**Why:** one key took 15 edits in 5 files, one of which was unguarded and caused a hard mount failure.
**Not the L version** `docs/68` declined: interfaces, the bespoke resolver throws and the `z.any()`
versus typed choice all stay.

**Edits:**

1. New `src/ef-keys.ts` exporting one table:

```ts
export const EF_KEYS = [
  { name: 'semanticMode',           presetOwned: true,  default: 'rationale' },
  { name: 'rationaleHintTokens',    presetOwned: true,  default: 800 },
  // ... the remaining 16, each with its default and whether a tier may set it
] as const
```

2. Derive from it: `EF_OWNED_CONFIG_KEYS` (the strip list — **the unguarded one**), `PRESET_OWNED` in
   both `preset.ts` and `effective-config.ts`, and the EF block of the `plugin-config.ts` schema.
3. Export `DEFAULT_RATIONALE_HINT_TOKENS` from `policy.ts` and have `ENGINE_DEFAULTS` import it, so the
   hardcoded `800` cannot drift.
4. Strengthen `tests/plugin-composition.spec.ts:251`: assert **set equality**, not subset, in both
   directions, and add the `EpistemicFoldConfig` interface to the guarded pair.

**Verification:** a new test that adds a dummy key to the table and asserts it appears in all four
derived lists; `npm run typecheck:all`; the existing config tests.

## 4. Proposal D — the directory move (navigation only)

**Why:** 53 of 58 files sit flat in `src/`; `eval/` has 10 directories for 48 files.

**Shape:** 6 root files (`index entry plugin doctor types compat`) + 7 directories (`config/ policy/
`fold/ checkpoint/ recall/ state/ status/`), `src/basic/` untouched.

**Order (measured churn, ascending):** `status/` 24 → `recall/` 39 → `state/` 47 → `fold/` 71 →
`checkpoint/` 79 → `config/` 77 → `policy/` 97. `config/` is deferred past `checkpoint/` despite lower
churn because it holds the two largest hubs and the only cycle.

**Gate:** `npm run typecheck:all` after each directory. Every missed specifier is a compile error, which
is what makes a 366-edit move safe — but only if the gate covers `eval/` too, which is Proposal A.

**Do not bundle a module split into a move commit.**

## 5. Proposal E — engine.ts on responsibility boundaries

10 responsibilities, 26 getters, `compactIfNeeded` 334 lines. **`docs/68` §7's numeric trigger has NOT
fired** (only 4 shipped files exceed 600 lines), so the argument is not line count — it is that the
file owns ten unrelated things. Split points are in `docs/134`.

## 6. What is NOT proposed, and why

- Merging `status.ts` / `status-projection.ts` — the divergence is documented as honest, and 18 vs 17
  fields with ~11 shared is a real distinction, not duplication.
- `inventory.ts` — archive content policy, a separate concern.
- Reopening `docs/68` C-2 (`bridge-host.ts` split), C-4 (`RecallMode`), C-5 (`basic/` unification).
- `src/basic/**` — vendored, regenerated by `scripts/vendor-basic.mjs`, pinned by
  `tests/rc7-vendored-basic.spec.ts`.

## 7. Recommended execution order

```
A  eval typecheck + its 4 errors + the package.json gate     S/M   unblocks every later gate
B  ghost keys and stale comments                             S     my own debris
C  EF key table, scoped to M                                 M     removes the unguarded failure
D  directory move, 7 commits in churn order                  L     navigation; needs A as its gate
E  engine.ts split                                           L     last, and separable
```
