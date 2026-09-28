/**
 * Eval schemas (R0-C1): closed zod schemas for boundary cases, oracles,
 * action records, run results, and compression incidents
 * (docs/08_BOUNDARY_CORPUS_PROTOCOL.md). Unknown fields are rejected —
 * a closed validator rather than arbitrary sidecars.
 *
 * @module eval/schema
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Oracles (closed union — docs/08 §7)
// ---------------------------------------------------------------------------

export const oracleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tests-pass'), command: z.string() }),
  z.object({ type: z.literal('file-equals'), path: z.string(), sha256: z.string() }),
  z.object({ type: z.literal('file-unchanged'), path: z.string() }),
  z.object({ type: z.literal('file-changed'), path: z.string() }),
  z.object({ type: z.literal('forbidden-path-unchanged'), path: z.string() }),
  z.object({ type: z.literal('artifact-exists'), path: z.string() }),
  z.object({ type: z.literal('state-key-equals'), stateKey: z.string(), value: z.json() }),
  z.object({ type: z.literal('anchor-active'), anchorId: z.string() }),
  z.object({ type: z.literal('failure-open'), failureId: z.string() }),
  z.object({ type: z.literal('failure-retired'), failureId: z.string() }),
  z.object({ type: z.literal('obligation-open'), obligationId: z.string() }),
  z.object({ type: z.literal('recall-contains'), checkpointId: z.string(), substring: z.string() }),
  z.object({ type: z.literal('no-cross-session-recall') }),
  z.object({ type: z.literal('tool-action-absent'), family: z.string(), target: z.string().optional() }),
  z.object({ type: z.literal('tool-action-present'), family: z.string(), target: z.string().optional() }),
])

export type Oracle = z.infer<typeof oracleSchema>

// ---------------------------------------------------------------------------
// Actions (docs/08 §8-§10)
// ---------------------------------------------------------------------------

export const actionFamilySchema = z.enum([
  'read', 'search', 'test', 'edit', 'build', 'recall', 'delegate', 'other',
])

export type ActionFamily = z.infer<typeof actionFamilySchema>

export const actionRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  family: actionFamilySchema,
  toolName: z.string(),
  target: z.string().optional(),
  normalizedArgs: z.unknown(),
  argsHash: z.string(),
  /** Environment version before/after — required for duplicate detection. */
  beforeEnvironment: z.string().optional(),
  afterEnvironment: z.string().optional(),
  duplicate: z.boolean().optional(),
  duplicateOf: z.number().int().nonnegative().optional(),
})

export type ActionRecord = z.infer<typeof actionRecordSchema>

// ---------------------------------------------------------------------------
// Boundary case sidecar (docs/08 §3)
// ---------------------------------------------------------------------------

export const boundaryCaseSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  workload: z.enum(['coding', 'research', 'search', 'multi-agent']),
  tier: z.enum(['hard', 'exploratory']),
  source: z.object({
    sessionRole: z.string(),
    boundaryLabel: z.string(),
  }),
  fold: z.object({
    mode: z.enum(['leaf', 'root', 'emergency']),
    target: z.string(),
  }),
  continuation: z.object({
    input: z.array(z.string()),
    maxActions: z.number().int().positive(),
  }),
  oracle: z.object({
    success: z.array(oracleSchema),
  }),
  behavior: z.object({
    duplicateRules: z.array(z.object({ family: actionFamilySchema })),
  }),
  recall: z.object({
    required: z.boolean(),
  }),
  classification: z.object({
    expectedCapability: z.array(z.string()),
  }),
})

export type BoundaryCase = z.infer<typeof boundaryCaseSchema>

// ---------------------------------------------------------------------------
// Run result + incident (docs/09 §20, docs/08 §17)
// ---------------------------------------------------------------------------

export const compressionIncidentCategorySchema = z.enum([
  'authority_loss',
  'state_stale',
  'missing_obligation',
  'missing_evidence',
  'missing_rationale',
  'recall_not_triggered',
  'recall_failed',
  'duplicate_work',
  'wrong_target',
  'reopened_resolved_branch',
  'unknown',
])

export type CompressionIncidentCategory = z.infer<typeof compressionIncidentCategorySchema>

export const compressionIncidentSchema = z.object({
  version: z.literal(1),
  caseId: z.string(),
  efCommit: z.string(),
  dshCommit: z.string(),
  model: z.string().optional(),
  referenceArm: z.string(),
  failingArm: z.string(),
  category: compressionIncidentCategorySchema,
  evidence: z.object({
    actions: z.array(z.number().int()),
    verifierFailures: z.array(z.string()),
    relevantCheckpointIds: z.array(z.string()),
  }),
})

export type CompressionIncident = z.infer<typeof compressionIncidentSchema>

export const evalRunResultSchema = z.object({
  runVersion: z.literal(1),
  caseId: z.string(),
  arm: z.enum(['B1', 'E3a0', 'E3aR', 'B0']),
  replicate: z.number().int().nonnegative(),
  efCommit: z.string(),
  dshCommit: z.string(),
  model: z.string().optional(),
  success: z.boolean(),
  score: z.number().optional(),
  correctness: z.object({
    authorityLossRate: z.number().optional(),
    stateStalenessRate: z.number().optional(),
    provenanceCoverage: z.number().optional(),
    criticalViolations: z.array(z.string()),
  }),
  context: z.object({
    promptTokensTotal: z.number(),
    peakPromptTokens: z.number(),
    p95PromptTokens: z.number(),
    sharedPrefixTokensTotal: z.number(),
    invalidatedSuffixTokensTotal: z.number(),
    reclaimedTokensTotal: z.number(),
    pma: z.number().optional(),
  }),
  behavior: z.object({
    actions: z.number(),
    duplicateActions: z.number(),
    duplicateWorkRate: z.number(),
    recallCalls: z.number(),
  }),
})

export type EvalRunResult = z.infer<typeof evalRunResultSchema>
