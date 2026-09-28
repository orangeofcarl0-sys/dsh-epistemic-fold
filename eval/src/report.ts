/**
 * Report generation (R0-C1, work-order §5): Markdown/CSV views GENERATED
 * from machine JSON — the JSON result is the single source of truth.
 *
 * @module eval/report
 */

import type { BaselineResult } from '../../bench/paired-baseline.ts'
import type { CompressionIncident, EvalRunResult } from './schema.ts'

/** Render one arm's BaselineResult as a Markdown table fragment. */
export function baselineToMarkdown(result: BaselineResult): string {
  const lines = [
    `### Arm \`${result.arm}\``,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| absolutePrefixInvalidation | ${result.absolutePrefixInvalidation} |`,
    `| stablePrefixTokensTotal | ${result.stablePrefixTokensTotal} |`,
    `| prefixMutationRatio (PMA) | ${result.prefixMutationRatio === undefined ? 'undefined' : result.prefixMutationRatio.toFixed(3)} |`,
    `| reclaimedTokensTotal | ${result.reclaimedTokensTotal} |`,
    `| leafFoldCount | ${result.leafFoldCount} |`,
    `| rootFoldCount | ${result.rootFoldCount} |`,
    `| finalCheckpointLoad | ${result.finalCheckpointLoad} |`,
    `| promptTokens (total/mean/median/peak/p95) | ${result.promptSummary.totalPromptTokens} / ${result.promptSummary.meanPromptTokens.toFixed(1)} / ${result.promptSummary.medianPromptTokens} / ${result.promptSummary.peakPromptTokens} / ${result.promptSummary.p95PromptTokens} |`,
    `| frozenTokens (mean/peak/share) | ${result.frozenSummary.meanFrozenTokens.toFixed(1)} / ${result.frozenSummary.peakFrozenTokens} / ${(result.frozenSummary.frozenShareOfPrompt * 100).toFixed(1)}% |`,
    `| auxiliaryCompaction calls | ${result.auxiliaryCompaction.callCount} |`,
    '',
    '| ρ | Cost |',
    '|---|---|',
    ...result.cacheEconomics.map(point => `| ${point.rho} | ${point.cost.toFixed(1)} |`),
    '',
  ]
  return lines.join('\n')
}

/** Render one EvalRunResult as a compact Markdown fragment. */
export function runResultToMarkdown(result: EvalRunResult): string {
  return [
    `### Case \`${result.caseId}\` — arm \`${result.arm}\` (replicate ${result.replicate})`,
    '',
    `- success: **${result.success}**`,
    `- context: prompt ${result.context.promptTokensTotal} (peak ${result.context.peakPromptTokens}, p95 ${result.context.p95PromptTokens}), IST ${result.context.invalidatedSuffixTokensTotal}, reclaimed ${result.context.reclaimedTokensTotal}${result.context.pma === undefined ? '' : `, PMA ${result.context.pma.toFixed(3)}`}`,
    `- behavior: ${result.behavior.actions} actions, DWR ${result.behavior.duplicateWorkRate.toFixed(3)}, recallCalls ${result.behavior.recallCalls}`,
    `- critical violations: ${result.correctness.criticalViolations.length === 0 ? '(none)' : result.correctness.criticalViolations.join(', ')}`,
    '',
  ].join('\n')
}

/** Render incidents as Markdown. */
export function incidentsToMarkdown(incidents: readonly CompressionIncident[]): string {
  if (incidents.length === 0) return 'No compression incidents recorded.\n'
  return [
    '| case | failing arm | category | verifier failures |',
    '|---|---|---|---|',
    ...incidents.map(incident =>
      `| ${incident.caseId} | ${incident.failingArm} | ${incident.category} | ${incident.evidence.verifierFailures.length} |`),
    '',
  ].join('\n')
}

/** Emit CSV rows for machine-generated spreadsheets. */
export function resultsToCsv(results: readonly EvalRunResult[]): string {
  const header = 'caseId,arm,replicate,success,promptTokensTotal,peakPromptTokens,p95PromptTokens,invalidatedSuffixTokensTotal,reclaimedTokensTotal,actions,duplicateWorkRate,recallCalls,criticalViolations'
  const rows = results.map(result => [
    result.caseId,
    result.arm,
    result.replicate,
    result.success,
    result.context.promptTokensTotal,
    result.context.peakPromptTokens,
    result.context.p95PromptTokens,
    result.context.invalidatedSuffixTokensTotal,
    result.context.reclaimedTokensTotal,
    result.behavior.actions,
    result.behavior.duplicateWorkRate.toFixed(4),
    result.behavior.recallCalls,
    result.correctness.criticalViolations.length,
  ].join(','))
  return [header, ...rows].join('\n')
}
