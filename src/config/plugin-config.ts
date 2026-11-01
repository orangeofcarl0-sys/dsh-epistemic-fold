/**
 * The plugin's config SCHEMA, in its own module so the surface registrations in
 * `plugin.ts` are not buried under a 19-key declaration (docs/68 B-4).
 *
 * ## Descriptive, NOT restrictive
 *
 * schemastery passes unknown keys THROUGH: a key this object omits is still
 * accepted and still reaches the engine (docs/68 §4 measured exactly that with
 * `referentialArchive`, `leafAdmission`, `subagentRecall` and a bogus key).
 * So an omission here is a documentation and range-checking gap only. Do NOT
 * make this schema reject unknown keys, and do not add range validation that
 * would move which layer rejects a bad value: `policy.ts` resolves and
 * validates the EF-owned keys, and a schema that rejected first would change
 * the error a deployment sees (a behaviour change, not a refactor).
 *
 * `tests/plugin-composition.spec.ts` asserts that every key in
 * `efOwnedConfigKeys()` is declared here, so the gap cannot grow silently.
 *
 * @module dsh-epistemic-fold/plugin-config
 */

import z from '@deepseek-ai/schemastery'
import type { EpistemicFoldConfig } from './policy.ts'

/**
 * The declared plugin config surface. Basic's keys are declared so a loader
 * profile can set them; EF's keys are declared so the config a deployment
 * writes is documented in one place. Comments recording WHY a switch is strict
 * are load-bearing (docs/68 §6) and stay with their keys.
 */
export const EpistemicFoldPluginConfig: z<EpistemicFoldConfig> = z.object({
  thresholdRatio: z.number(),
  headroomTokens: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number(),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number(),
  compactionRetries: z.number(),
  maxOverflowRetries: z.number(),
  framingMode: z.union(['legacy', 'system-dedup'] as const),
  mode: z.union(['legacy', 'basic', 'economy', 'balanced', 'quality'] as const),
  auto: z.boolean(),
  modelPolicies: z.array(z.any()),
  frozenCheckpointTokenBudget: z.number(),
  semanticMode: z.union(['none', 'rationale'] as const),
  // EF-owned: resolveEfConfig validates the enum and the budget range, so a
  // typed declaration here would add a second validation layer (see the note
  // on the z.any() block below).
  semanticContinuity: z.any(),
  semanticWorkingSetTokens: z.any(),
  semanticCheckpointTokens: z.any(),
  semanticRoot: z.string(),
  bundleRoot: z.string(),
  // The rest of the EF-owned vocabulary (`efOwnedConfigKeys()`). Declared so the
  // schema is a COMPLETE index of the config keys, which
  // `tests/plugin-composition.spec.ts` now asserts by set equality.
  //
  // `z.any()` ON PURPOSE, not an oversight: `policy.ts` is the layer that
  // validates these and ranges them. A typed declaration here (z.number(),
  // z.boolean(), z.union) would make the SCHEMA reject a bad value BEFORE
  // `resolveEfConfig` does, which changes the error a loader deployment sees —
  // a behaviour change, not a refactor. Declaring the key adds documentation;
  // it must not add a second validation layer.
  // The tier's HINT budget. `z.any()` for the same reason as the rest of this block: policy.ts
  // validates and ranges it, and a typed declaration would add a second validation layer.
  rationaleHintTokens: z.any(),
  leafAdmission: z.any(),
  minReclaimTokens: z.any(),
  minReclaimRatio: z.any(),
  rootPolicy: z.any(),
  economicsProfiles: z.any(),
  cacheRealizationRate: z.any(),
  paybackHorizonRequests: z.any(),
  referentialArchive: z.any(),
  allowCrossSessionRecall: z.any(),
  // EXPERIMENTAL (docs/67). Strict, like the other switches: a typo must not silently
  // turn on a feature that changes what a recall RETURNS.
  subagentRecall: z.boolean(),
  subagentRecallThresholdChars: z.number(),
  subagentRecallFetchBudgetChars: z.number(),
})
