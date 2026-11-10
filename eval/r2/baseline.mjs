#!/usr/bin/env node
/**
 * EF-R2 WP0 — freeze the baseline the round argues from.
 *
 * This file exists so a later reader can check the two facts that decide how
 * the rest of EF-R2 is read:
 *
 *   1. the E1 arm's 42 calls / 11 commits / 31 failures are the recorded
 *      numbers, not a retelling;
 *   2. the campaign ran `leafAdmission: legacy`, while every shipped tier
 *      selects `economic`, so the arm is NOT the shipped economy tier.
 *
 * Nothing here calls a provider. Reports and source files are read only.
 *
 *   node eval/r2/baseline.mjs
 *
 * @module eval/r2/baseline
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const CAMPAIGN = 'e2e-lg-confirm-1'

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const tryText = (command, args, cwd = ROOT) => {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
  } catch (error) {
    return `(failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`
  }
}
const tryJson = (command, args, cwd = ROOT) => {
  const text = tryText(command, args, cwd)
  if (text.startsWith('(failed:')) return { error: text }
  try {
    return JSON.parse(text)
  } catch (error) {
    return { error: `unparseable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Read one source constant without importing the TypeScript module. */
function sourceConstant(path, pattern) {
  const text = readFileSync(path, 'utf8')
  const match = pattern.exec(text)
  return match === null ? null : match[1] ?? match[0]
}

const analysis = readJson(join(E2E_OUT, `analysis-${CAMPAIGN}.json`))
const e1 = analysis.byArm?.E1 ?? null
const rows = (analysis.rows ?? []).filter(row => row.arm === 'E1')

/** Every compaction error in the 24 E1 reports, deduplicated. */
const errors = new Map()
const bundleInventory = []
for (const row of rows) {
  const reportPath = join(ROOT, row.reportPath)
  if (!existsSync(reportPath)) continue
  const report = readJson(reportPath)
  for (const compaction of report.compactions ?? []) {
    if (compaction.error === null) continue
    const text = String(compaction.error)
    errors.set(text, (errors.get(text) ?? 0) + 1)
  }
  const cellRoot = dirname(reportPath)
  const bundleDir = join(cellRoot, 'bundles')
  let bundleFiles = 0
  let commitRecords = 0
  if (existsSync(bundleDir)) {
    for (const session of readdirSync(bundleDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const file of readdirSync(join(bundleDir, session.name))) {
        if (file.startsWith('bundle-')) bundleFiles += 1
        if (file.startsWith('commit-')) commitRecords += 1
      }
    }
  }
  bundleInventory.push({
    cellId: row.cellId,
    attempts: row.foldAttempts,
    folds: row.folds,
    failed: row.foldFailures,
    checkpoint: row.checkpoint !== null,
    bundleFiles,
    commitRecords,
    retainedTokens: row.retainedTokens,
  })
}

const errorRows = [...errors.entries()]
  .map(([text, count]) => {
    const match = /summary is not smaller than the shadowed content \((\d+) estimated framed tokens >= (\d+)\)/u.exec(text)
    return {
      text,
      count,
      kind: match === null ? 'other' : 'shrink-refusal',
      framedTokens: match === null ? null : Number(match[1]),
      shadowedTokens: match === null ? null : Number(match[2]),
    }
  })
  .sort((left, right) => right.count - left.count)

const shrink = errorRows.filter(row => row.kind === 'shrink-refusal')
const framed = shrink.map(row => row.framedTokens).filter(value => value !== null)
const shadowed = shrink.map(row => row.shadowedTokens).filter(value => value !== null)

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP0',
  generatedAt: new Date().toISOString(),
  git: {
    worktree: ROOT.replace(/\\/gu, '/'),
    head: tryText('git', ['rev-parse', 'HEAD']),
    branch: tryText('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    headSubject: tryText('git', ['log', '-1', '--format=%s']),
    status: tryText('git', ['status', '--porcelain=v1']),
  },
  pullRequest: tryJson('gh', ['pr', 'view', '5', '--json', 'number,state,headRefName,headRefOid,baseRefName,mergeable,url']),
  ci: tryJson('gh', ['run', 'list', '--branch', 'chore/ef-c1-evaluation-foundation', '--limit', '5', '--json', 'databaseId,workflowName,status,conclusion,headSha,createdAt']),
  campaign: CAMPAIGN,
  e1: e1 === null ? null : {
    cells: e1.cells,
    checkerPasses: e1.checkerPasses,
    folds: e1.folds,
    foldFailures: e1.foldFailures,
    attempts: (e1.folds ?? 0) + (e1.foldFailures ?? 0),
    auxiliaryRequests: e1.auxiliaryRequests,
    noFold: e1.noFold,
    requests: e1.requests,
    inputTokens: e1.inputTokens,
    outputTokens: e1.outputTokens,
    consistent: e1.auxiliaryRequests === (e1.folds ?? 0) + (e1.foldFailures ?? 0)
      && e1.noFold === e1.cells - e1.folds,
  },
  e1Errors: {
    unique: errorRows.length,
    shrinkRefusals: shrink.reduce((sum, row) => sum + row.count, 0),
    otherKinds: errorRows.filter(row => row.kind !== 'shrink-refusal').length,
    framedTokens: framed.length === 0 ? null : { min: Math.min(...framed), max: Math.max(...framed) },
    shadowedTokens: shadowed.length === 0 ? null : { min: Math.min(...shadowed), max: Math.max(...shadowed) },
    rows: errorRows,
  },
  e1Bundles: {
    cellsWithOrphanBundles: bundleInventory.filter(row => row.failed > 0 && row.bundleFiles > row.commitRecords).length,
    totalBundleFiles: bundleInventory.reduce((sum, row) => sum + row.bundleFiles, 0),
    totalCommitRecords: bundleInventory.reduce((sum, row) => sum + row.commitRecords, 0),
    rows: bundleInventory,
  },
  configurationAudit: {
    leafAdmissionDefault: sourceConstant(join(ROOT, 'src', 'config', 'policy.ts'), /DEFAULT_LEAF_ADMISSION[^=]*=\s*'([^']+)'/u),
    minReclaimTokens: sourceConstant(join(ROOT, 'src', 'config', 'policy.ts'), /DEFAULT_MIN_RECLAIM_TOKENS\s*=\s*(\d+)/u),
    framingFallbackTokens: sourceConstant(join(ROOT, 'src', 'policy', 'fold-economics.ts'), /FRAMING_FALLBACK_TOKENS\s*=\s*(\d+)/u),
    e2eHostPassesLeafAdmission: /leafAdmission/u.test(readFileSync(join(ROOT, 'eval', 'e2e', 'src', 'host.mjs'), 'utf8')),
    tiersSetEconomic: (readFileSync(join(ROOT, 'src', 'config', 'preset.ts'), 'utf8').match(/leafAdmission:\s*'economic'/gu) ?? []).length,
    rationaleOutputFloor: sourceConstant(join(ROOT, 'src', 'checkpoint', 'rationale.ts'), /Math\.max\((\d{2}[_,]\d{3})/u),
    rationaleOutputCeiling: sourceConstant(join(ROOT, 'src', 'checkpoint', 'rationale.ts'), /Math\.min\((\d{2}[_,]\d{3})/u),
    perCellOutputTokens: (() => {
      const text = readFileSync(join(ROOT, 'eval', 'e2e', 'src', 'freeze.mjs'), 'utf8')
      const match = /PER_CELL\s*=\s*\{[^}]*outputTokens:\s*([\d_]+)/su.exec(text)
      return match === null ? null : match[1]
    })(),
    note: 'The E2E host passes mode/semanticMode/flags but not leafAdmission, so the plugin default (legacy) applies. Every shipped tier sets leafAdmission: economic. The 120-cell E1 arm is therefore E1-legacy-admission, not the shipped economy tier.',
  },
  pointers: {
    r1Archive: existsSync(join(ROOT, 'eval', 'ef-r1', 'out', 'research-archive-r1.json'))
      ? { path: 'eval/ef-r1/out/research-archive-r1.json', sha256: sha256(join(ROOT, 'eval', 'ef-r1', 'out', 'research-archive-r1.json')) }
      : null,
    stageAttribution: existsSync(join(E2E_OUT, 'stage-attribution.json'))
      ? { path: 'eval/e2e/out/stage-attribution.json', sha256: sha256(join(E2E_OUT, 'stage-attribution.json')) }
      : null,
    confirmResults: existsSync(join(E2E_OUT, `results-${CAMPAIGN}.json`))
      ? { path: `eval/e2e/out/results-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `results-${CAMPAIGN}.json`)) }
      : null,
    confirmAnalysis: existsSync(join(E2E_OUT, `analysis-${CAMPAIGN}.json`))
      ? { path: `eval/e2e/out/analysis-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `analysis-${CAMPAIGN}.json`)) }
      : null,
  },
  note: 'Baseline only. No provider call, no historical file modified.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'baseline.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

process.stdout.write(`baseline: HEAD ${output.git.head.slice(0, 8)} branch ${output.git.branch}\n`)
process.stdout.write(`E1 cells ${e1?.cells} pass ${e1?.checkerPasses} attempts ${(e1?.folds ?? 0) + (e1?.foldFailures ?? 0)} folds ${e1?.folds} failures ${e1?.foldFailures}\n`)
process.stdout.write(`errors: ${errorRows.length} unique, ${output.e1Errors.shrinkRefusals} shrink refusals, ${output.e1Errors.otherKinds} other\n`)
process.stdout.write(`bundles: ${output.e1Bundles.totalBundleFiles} bundle files, ${output.e1Bundles.totalCommitRecords} commit records, ${output.e1Bundles.cellsWithOrphanBundles} cells with orphan bundles\n`)
process.stdout.write(`leafAdmission default ${output.configurationAudit.leafAdmissionDefault}; host passes it: ${output.configurationAudit.e2eHostPassesLeafAdmission}; tiers economic: ${output.configurationAudit.tiersSetEconomic}\n`)
