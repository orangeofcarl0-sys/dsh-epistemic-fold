# Integration with the EF main line

## Baselines

```
feature prototype branch   rc29-working-set-observer @ bd1131c   (flat src/)
target main                origin/main @ 93b6666                (243 commits ahead)
integration branch         rc30-semantic-continuity             (worktree)
```

The target main had restructured `src/` into
`{basic,checkpoint,config,fold,policy,recall,state,status}` and added capabilities
the old branch did not have. The work was NOT continued on the flat branch:
a separate worktree holds the integration, and the prototype worktree remains
untouched (plus a full snapshot ref `snapshot/pre-semantic-audit-v1` and an
external patch/untracked copy).

## Mapping applied

| Prototype (flat) | Main line (integrated) |
|---|---|
| `src/engine.ts` | `src/fold/engine.ts` |
| `src/state.ts` | `src/state/state.ts` |
| `src/authority.ts` | `src/state/authority.ts` |
| `src/anchor-service.ts` | `src/state/anchor-service.ts` |
| `src/projection.ts` | `src/state/projection.ts` |
| `src/renderer.ts` | `src/checkpoint/renderer.ts` |
| `src/compiler.ts` (render paths) | `src/checkpoint/compiler.ts` |
| `src/rationale.ts` | `src/checkpoint/rationale.ts` |
| `src/policy.ts` | `src/config/policy.ts` (+ `ef-keys.ts`, `plugin-config.ts`) |
| `src/working-set.ts` | `src/checkpoint/residency.ts` |
| `src/status.ts`, `src/command.ts` | `src/status/{status,command}.ts` |
| new | `src/semantic/*` (9 modules) |
| new | `src/state/plugin-events.ts` |

## Main-line capabilities preserved

- **Task Root** (`fold/task-root.ts`) and its bridge tests: unchanged, green.
- **Phase Exit / checkpoint residency** (`checkpoint/residency.ts`): unchanged
  logic; its retirement write now uses the transport, so it is no longer a
  guaranteed failure on 0.2.1.
- **Summary truncation retry** (`checkpoint/summary-retry.ts` +
  `summarizeWithTruncationRetry`): restored after the rewrite and still used by
  `mode: basic` and the legacy path.
- **Subagent recall / derived-answer retirement**: the fold hook still retires
  paraphrases before the writer sees the span.
- **Framing modes** (`legacy`, `system-dedup`), economics tiers, pressure/root
  policy, status surfaces: untouched; the semantic layer reads their outputs.
- **`mode: basic`**: still native Basic, no bundle, no semantic writer.

## Conflicts and how they were handled

1. **Vendored DSH is 0.1.7-rc.2; main declares `engines.dsh >=0.2.0-rc.2`.**
   This is pre-existing (the baseline run fails
   `rc3-plugin-packaging` "declares the DSH range at engines.dsh" for this
   reason). The integration does not paper over it: the test suite runs against
   the vendor, and the real 0.2.1 API is covered by a dedicated test using
   `createRequire`. Resolving the mismatch means updating the vendor checkout,
   which is an environment decision, not a semantic-feature change.
2. **`cordis.patch.yml` regeneration on install.** `npm install` runs
   `scripts/generate-presets.mjs`, which rewrites `cordis.patch.yml` from the
   installed DSH. The integration tree reverts that generated change so the
   plugin-assembly diff stays isolated (the same drift existed at baseline:
   `rc7-inplace-drift` fails before and after). Do not commit a regenerated patch
   as part of this feature.
3. **Missing devDependencies in main.** `tsc` could not resolve
   `dsh-compaction-basic` or `dsh-session-persistence`, and `npm` resolved the
   host peers to 0.2.0-rc.2. The integration pins every host package the code or
   tests import to **0.2.1-rc.3** in `devDependencies`, and pins `zod` to 4.4.3
   so the projection's schema types unify (the host itself nests 4.4.3 under
   `dsh-token-meter`).
4. **`@deepseek-ai/...` aliasing.** `vitest.config.ts` resolves the host
   packages to the vendored sources. The real-host test bypasses the alias
   deliberately; the rest of the suite keeps main's configured runtime.
5. **`renderStructuredCheckpoint` hardcoded `leaf`.** Root/emergency bodies were
   being stamped as leaf. The integration adds a `mode` parameter and passes the
   candidate's real mode. Existing leaf expectations are unchanged.

## Not migrated (superseded on purpose)

- The prototype's `semantic/reconcile.ts` (bounded-state oracle) and
  `committedDeltaIds` journal API: replaced by `plan.ts` + `commit.ts` +
  `record.ts`.
- The prototype's `docs/semantic-continuity/{SPEC,BASELINE}.md`: their design
  content is folded into `TRANSACTION.md`, `REVIEW.md`, and this file; keeping
  two versions would invite drift.
- No changes were made to `src/basic/*`: the vendored Basic transaction is the
  commit authority and remains untouched.

## Verification of the integration

- Typecheck: clean against the tree's configured types.
- Build: `npm run build` writes `lib/`; the packaging preflight passes after it.
- Full suite: see `EVALUATION.md` for the exact numbers and the failure
  classification. The only new-behavior regressions introduced during integration
  were the three `/context mode` tests, caused by an over-strict runtime guard on
  `semanticRoot`; the guard was narrowed and those tests are green.
