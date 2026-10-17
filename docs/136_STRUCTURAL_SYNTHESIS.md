# 136 — Structural synthesis: three audits, and what to do about them

Three teammates audited the tree in parallel. This is the Lead's synthesis: what is established, what
is contested, what the earlier plan (`docs/68`) already settled, and a recommended order of work.
**No code was changed by any of them, and none is changed here.**

## The inputs

| doc | scope | size |
|---|---|---|
| `docs/133_SRC_STRUCTURE_AUDIT.md` | module graph, layout proposal, churn | 328 lines |
| `docs/134_COMPLEXITY_AUDIT.md` | god files, duplication, dead exports | 444 lines |
| `docs/135_ABSTRACTION_AUDIT.md` | config / telemetry / rendering / names | 313 lines |
| `docs/68_STRUCTURAL_AUDIT_AND_PLAN.md` | the PRIOR audit: Tiers A-D | pre-existing |

`docs/68` is not superseded. Its Tiers A and B are done, Tier C was declined with reasons, and Tier D
is four owner decisions. Its own §11 measured this codebase as **not** a ball of mud. Everything below
either extends it or contradicts it with new evidence, and says which.

## 1. The layout question is new, and it is a navigability change

`docs/68` never addressed folder layout — it audited drift sites and line counts. So the owner's
complaint is a genuine gap, not a re-litigation.

Measured: `src/` is 58 files / 15,627 lines, and **53 of them (13,851 lines) sit flat in the root**.
`eval/` has 10 subdirectories for 48 files. The asymmetry is real.

**Proposal (measured, not guessed):** 53 flat files → 6 root files + 7 directories:

```
src/  index.ts  entry.ts  plugin.ts  doctor.ts  types.ts  compat.ts
      config/  policy/  fold/  checkpoint/  recall/  state/  status/
      basic/        <- vendored, untouched
```

**Cost: 366 specifier edits across 117 files** (148 internal + 218 external into moved files; 28 in
`src/`, 89 in `tests/`, `eval/`, `bench/`, `scripts/`). Risk order: **status → recall → state → fold →
checkpoint → config → policy**, with `config/` deferred past `checkpoint/` because it holds the two
largest hubs (`policy` fan-in 17, `preset` fan-in 14) plus the only cycle.

**No hidden churn**, which is what makes this affordable: `tsconfig.json:305-306` globs `src/**/*.ts` and
`scripts/build-plugin.mjs:51-59` walks `src/` recursively, so new directories need no config change.

## 2. Two findings that are defects, not tidiness

### 2a. The telemetry vocabulary has already drifted, and no compiler can see it

Six hand-maintained lists. Diffing the bridge's `Telemetry` interface against the object it returns
gives exactly one excess key: **`lastLeafDecision`, emitted at `bridge-host.ts:1954` and declared
nowhere.**

Root cause: `tsconfig.json` `include` is `["src/**/*.ts", "tests/**/*.ts"]` — **`eval/` is outside every
tsconfig**, so `Promise<Telemetry>` is never type-checked.

### 2b. Four whitelisted telemetry keys do not exist on the wire

`run_cell.py:510-518` whitelists `leafAdmission`, `postLeafRegime`, `foldReachability` and
`thresholdTokens`. The first three have **0 occurrences** in `bridge-host.ts`; `thresholdTokens` exists
only nested inside `compactBudget`. All four read `null` in **15 of 15** `eval/memory/result_*.json`.

**This is the Lead's own error and it is worth stating plainly.** On 2026-10-17 I widened that whitelist
from 9 keys to 22 to capture "the fields that say WHY", and I reported readings from it. Three of the
added keys never existed, and I recorded `postLeafRegime` and `foldReachability` as **empty** in my own
output without investigating why. A widened observer that silently reads null is worse than a narrow
one: it looks like coverage.

## 3. The config chain, counted — and a correction

Adding ONE EF-owned key (`rationaleHintTokens`) took **14 registration sites + 1 consumer = 15 edits in
5 files** (plus 1 scenario value = 6 files): `policy.ts` ×6, `preset.ts` ×5, `effective-config.ts` ×2,
`plugin-config.ts` ×1, `engine.ts` ×1.

**Correction to the Lead's earlier attribution.** I blamed `plugin-config.ts` for the hard failure
`BasicCompactionConfig: unknown key "rationaleHintTokens"`. Reproduced read-only: schemastery passes an
**undeclared key through**, so a schema omission has no runtime effect — it only fails the B-5
set-equality test. The hard error comes from `EF_OWNED_CONFIG_KEYS` in `policy.ts`, via
`src/basic/config.ts:338`. That also explains why two Python fixtures died without naming the key: the
**tier** supplies it, so every economy/balanced/quality mount failed.

**Guard asymmetry:** `tests/plugin-composition.spec.ts:251` checks the schema is a SUPERSET of the owned
list — blind to the dangerous direction (a key in the schema but missing from the strip list). And
`ENGINE_DEFAULTS` hardcodes `800` because `DEFAULT_RATIONALE_HINT_TOKENS` is private; the two agree
today only by luck, with no test comparing them.

**Re-judgement of `docs/68` C-1:** its decline was right AS SCOPED (L-cost: deriving interfaces plus 20
bespoke resolver throws changes error text and types, which tests pin). But §5's inference — "config
drift has zero functional impact" — generalised from one site class to all of them, and the strip list
falsifies it. **Reopen C-1, scoped down to M:** one table `{name, default, presetOwned}` deriving only
the four lists and the schema's EF block.

## 4. What the audits say about the god files

`engine.ts` 2,147 lines / 31 imports / 26 getters / `compactIfNeeded` alone 334 lines. `recall.ts`
1,040 — it **doubled from 528 in one commit**. `bridge-host.ts` 2,244 (a harness, not shipped).

But `docs/68` §7 set a numeric revisit trigger, and **it has not fired**: only 4 shipped files exceed
600 lines. So the honest verdict on file size is: `engine.ts` is large and worth splitting on
RESPONSIBILITY boundaries, but "it is 2,147 lines" is not by itself the argument.

## 5. Two stale comments my own change left behind

`preset.ts:228-232` still says *"No LLM call for a checkpoint"* directly above
`semanticMode: 'rationale'`, and `:253-255` still says the rungs differ ONLY by retention when they now
differ by `rationaleHintTokens` 400/800/1600. Also `fold-telemetry.ts:93` still cites
`RATIONALE_MAX_TOKENS = 400`, a constant I deleted.

## 6. Recommended order

**Do first, because they are defects with cheap fixes:**

1. **The telemetry vocabulary owner** (S/M, low risk). Add `eval/**` to a tsconfig, move
   `Telemetry`/`CompactBudget`/`FoldEvent` out of the harness, and add a parse-only test asserting the
   bridge keys and the Python whitelist against `FoldTelemetry`. This would have caught all four null
   columns and the undeclared `lastLeafDecision`.
2. **Fix the four ghost keys and the stale comments** (S). Delete the three non-existent whitelist
   entries; correct the three stale comments.
3. **EF key table, scoped to M** (M, low/medium). Removes four duplicated lists, the unguarded mount
   failure, and the hardcoded `800`.

**Do second, as one navigability commit per cluster:**

4. The directory move, in the measured risk order. Gate: `npm run typecheck` after each cluster — every
   missed specifier is a compile error. **Do not bundle a module split into a move commit.**

**Do third, or opportunistically:**

5. `engine.ts` split on responsibility boundaries; one checkpoint-text owner (move the fallback/semantic
   renderers beside `renderStructuredCheckpoint` with one dispatcher, and bundle assembly to `bundle.ts`).

**Do not do:** merging `status.ts`/`status-projection.ts` (the divergence is documented as honest),
touching `inventory.ts` (separate concern), or reopening the declined C-2/C-4.

## 7. Not established

- Whether `lastLeafDecision` is a hard `tsc` error in practice — no teammate ran `tsc`.
- Whether any of the 68 dead exports has a consumer outside the repo.
- Whether the 18 `EF_*` config keys already differ name-by-name between the interface and the strip list.
- The 5 genuinely two-sided placements in `docs/133` §10 (`framing`, `tools`, `inventory`,
  `summary-retry`, `rationale`) — the directory names are the auditor's proposal, not a measurement.
