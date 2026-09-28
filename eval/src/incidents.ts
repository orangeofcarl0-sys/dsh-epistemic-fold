/**
 * Compression incident classification (R0-C1, docs/08 §17): when a paired
 * run has a reference arm succeeding where the failing arm failed, classify
 * WHY from the machine evidence — never from agent self-report.
 *
 * @module eval/incidents
 */

import type { CompressionIncident, CompressionIncidentCategory } from './schema.ts'
import type { OracleVerdict } from './verifier.ts'

/** The evidence face the classifier consumes for one failed arm. */
export interface IncidentInput {
  caseId: string
  efCommit: string
  dshCommit: string
  model?: string
  referenceArm: string
  failingArm: string
  /** Oracles the failing arm missed (from the verifier). */
  verifierFailures: readonly string[]
  /** Post-boundary actions (normalized) of the failing arm. */
  failingActions: ReadonlyArray<{ index: number; family: string; target?: string; duplicate?: boolean }>
  /** EF current-state faces of the failing arm at the end of the run. */
  state: {
    activeAnchorIds: ReadonlySet<string>
    openFailureIds: ReadonlySet<string>
    retiredFailureIds: ReadonlySet<string>
    openObligationIds: ReadonlySet<string>
  }
  /** Oracles that required recall, and whether recall was triggered. */
  recallRequired: boolean
  recallTriggered: boolean
  recallSucceeded: boolean
  /** The oracles the scenario checks. */
  oracles: readonly OracleVerdict[]
  relevantCheckpointIds: readonly string[]
}

/**
 * Classify one paired regression into a closed category, priority-ordered so
 * the most structural cause wins (a state failure explains a duplicate-work
 * symptom, not the other way around).
 */
export function classifyIncident(input: IncidentInput): CompressionIncident {
  return {
    version: 1,
    caseId: input.caseId,
    efCommit: input.efCommit,
    dshCommit: input.dshCommit,
    ...(input.model === undefined ? {} : { model: input.model }),
    referenceArm: input.referenceArm,
    failingArm: input.failingArm,
    category: categorize(input),
    evidence: {
      actions: input.failingActions.map(action => action.index),
      verifierFailures: [...input.verifierFailures],
      relevantCheckpointIds: [...input.relevantCheckpointIds],
    },
  }
}

function categorize(input: IncidentInput): CompressionIncidentCategory {
  const oracleByType = new Map<string, OracleVerdict>()
  for (const verdict of input.oracles) oracleByType.set(verdict.oracle.type, verdict)

  // Authority: a normative anchor went missing while its oracle demanded it.
  const anchorMissing = [...input.oracles].some(verdict =>
    verdict.oracle.type === 'anchor-active' && !verdict.passed)
  if (anchorMissing && !input.state.activeAnchorIds.size) return 'authority_loss'

  // Stale state: a state-key oracle failed while the key still exists.
  const stateKeyFailed = [...input.oracles].some(verdict =>
    verdict.oracle.type === 'state-key-equals' && !verdict.passed)
  if (stateKeyFailed) return 'state_stale'

  // Obligation: an obligation-open oracle failed.
  const obligationMissing = [...input.oracles].some(verdict =>
    verdict.oracle.type === 'obligation-open' && !verdict.passed)
  if (obligationMissing && !input.state.openObligationIds.size) return 'missing_obligation'

  // Recall: required but not triggered, or triggered but failed.
  if (input.recallRequired && !input.recallTriggered) return 'recall_not_triggered'
  if (input.recallRequired && input.recallTriggered && !input.recallSucceeded) return 'recall_failed'
  const recallOracleMissing = [...input.oracles].some(verdict =>
    verdict.oracle.type === 'recall-contains' && !verdict.passed)
  if (recallOracleMissing) return 'recall_failed'

  // Failure lifecycle regressions.
  const failureRetiredOracle = oracleByType.get('failure-retired')
  if (failureRetiredOracle !== undefined && !failureRetiredOracle.passed) return 'missing_evidence'
  const failureOpenOracle = oracleByType.get('failure-open')
  if (failureOpenOracle !== undefined && !failureOpenOracle.passed
    && input.state.retiredFailureIds.size > 0) return 'reopened_resolved_branch'

  // Rationale slot empty in a rationale-mode arm.
  const rationaleMissing = [...input.oracles].some(verdict =>
    verdict.oracle.type === 'recall-contains' && verdict.oracle.substring === 'Rationale' && !verdict.passed)
  if (rationaleMissing && input.failingArm === 'E3a0') return 'missing_rationale'

  // Duplicate work without a state-level cause.
  const duplicates = input.failingActions.filter(action => action.duplicate === true)
  if (duplicates.length > 0) return 'duplicate_work'

  // Wrong target: an edit/build landed but oracles about content failed.
  const edited = input.failingActions.some(action => action.family === 'edit' || action.family === 'build')
  const contentFailed = input.verifierFailures.some(detail => detail.startsWith('file-'))
  if (edited && contentFailed) return 'wrong_target'

  return 'unknown'
}
