#!/usr/bin/env node
/**
 * EF-R4 — zero-provider preflight for the frozen budget-sensitivity manifest.
 *
 * This does not resolve a live route and does not read a credential. It checks
 * the manifest's structure, task digests, envelope arithmetic, and the fact that
 * the authorization is still a request rather than a grant.
 *
 *   node eval/r4/preflight-budget-manifest.mjs
 *
 * @module eval/r4/preflight-budget-manifest
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(ROOT, 'eval', 'r4', 'out')
const CAMPAIGN = 'e2e-r4-budget-sensitivity-1'
const ARMS = ['B0', 'E0', 'E1']
const TASKS = ['T11-p1', 'T12-p1', 'T13-p1', 'T14-p1', 'T15-p1', 'T16-p1']

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sha256Text = text => createHash('sha256').update(text, 'utf8').digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

function sourceTreeDigest() {
  const lines = git('ls-tree', '-r', 'HEAD').split('\n').filter(line => {
    const path = line.slice(line.indexOf('\t') + 1)
    return path !== 'eval/e2e/authorization.json'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/r3/out/')
      && !path.startsWith('eval/r4/out/')
  })
  return sha256Text(lines.join('\n'))
}

function dirtyPaths() {
  return git('status', '--porcelain')
    .split('\n')
    .map(line => line.replace(/\r$/u, ''))
    .filter(Boolean)
    .map(line => line.slice(3))
    .filter(path => path !== 'ef-phase7-logs/watchdog.heartbeat'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/e2e/runs/')
      && !path.startsWith('eval/r3/out/')
      && !path.startsWith('eval/r4/out/'))
}

function main() {
  const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
  const authorizationPath = join(E2E_OUT, `authorization-${CAMPAIGN}.json`)
  const pointerPath = join(OUT, 'budget-manifest.json')
  const designPath = join(OUT, 'budget-sensitivity-design.json')
  for (const path of [manifestPath, authorizationPath, pointerPath, designPath]) {
    if (!existsSync(path)) {
      process.stderr.write(`preflight-budget-manifest: ${path} is missing\n`)
      process.exit(2)
    }
  }
  const manifest = readJson(manifestPath)
  const authorization = readJson(authorizationPath)
  const pointer = readJson(pointerPath)
  const design = readJson(designPath)

  const checks = []
  const check = (id, pass, detail) => checks.push({ id, pass: pass === true, detail })
  const manifestSha = sha256File(manifestPath)
  const authorizationSha = sha256File(authorizationPath)
  const sourceDigest = sourceTreeDigest()
  const dirty = dirtyPaths()
  const cells = manifest.cells ?? []
  const combos = new Set(cells.map(cell => `${cell.task}:${cell.arm}:${cell.maxSteps}`))
  const blockBalanced = [...new Set(cells.map(cell => cell.block))].every(block => {
    const subset = cells.filter(cell => cell.block === block)
    return subset.length === 6
      && ARMS.every(arm => subset.filter(cell => cell.arm === arm).length === 2)
      && [8, 16].every(budget => subset.filter(cell => cell.maxSteps === budget).length === 3)
  })
  const perTask = TASKS.map(task => cells.filter(cell => cell.task === task).length)
  const perArm = ARMS.map(arm => cells.filter(cell => cell.arm === arm).length)
  const perBudget = [8, 16].map(budget => cells.filter(cell => cell.maxSteps === budget).length)

  check('campaign', manifest.campaign === CAMPAIGN, manifest.campaign)
  check('cell-count', cells.length === 36, cells.length)
  check('unique-task-arm-budget', combos.size === 36, combos.size)
  check('balanced-blocks', blockBalanced, blockBalanced)
  check('each-task-six', perTask.every(count => count === 6), perTask)
  check('each-arm-twelve', perArm.every(count => count === 12), perArm)
  check('each-budget-eighteen', perBudget.every(count => count === 18), perBudget)
  check('budgets-only-8-16', cells.every(cell => cell.maxSteps === 8 || cell.maxSteps === 16), null)
  check('execution-not-authorized', manifest.executionAuthorized === false, manifest.executionAuthorized)
  check('authorization-not-granted', authorization.granted === false, authorization.granted)
  check('authorization-binds-manifest', authorization.manifestSha256 === manifestSha, {
    authorization: authorization.manifestSha256,
    manifest: manifestSha,
  })
  check('pointer-binds-manifest', pointer.manifest?.sha256 === manifestSha, pointer.manifest?.sha256)
  check('pointer-binds-authorization', pointer.authorization?.sha256 === authorizationSha, pointer.authorization?.sha256)
  check('source-tree-digest', manifest.code?.sourceTreeDigest === sourceDigest, {
    manifest: manifest.code?.sourceTreeDigest,
    current: sourceDigest,
  })
  check('worktree-clean', dirty.length === 0, dirty)
  check('task-digests', (manifest.tasks ?? []).every(task => {
    const path = join(ROOT, task.file)
    return existsSync(path) && sha256File(path) === task.digest
  }), (manifest.tasks ?? []).map(task => task.id))
  check('task-set', JSON.stringify((manifest.tasks ?? []).map(task => task.id)) === JSON.stringify(TASKS), (manifest.tasks ?? []).map(task => task.id))
  check('config-context-window', manifest.config?.operationalBudgetTokens === 32_768, manifest.config?.operationalBudgetTokens)
  check('config-retain', manifest.config?.retainRatio === 0.16, manifest.config?.retainRatio)
  check('config-hint', manifest.config?.rationaleHintTokens === 400, manifest.config?.rationaleHintTokens)
  check('config-framing', manifest.config?.framingMode === 'system-dedup', manifest.config?.framingMode)
  check('config-strict-usage', manifest.config?.strictUsage === true, manifest.config?.strictUsage)
  check('config-default-max-steps', manifest.config?.maxSteps === 8, manifest.config?.maxSteps)
  const perCell = manifest.perCell ?? {}
  const limits = manifest.limits ?? {}
  check('envelope-positive', [limits.httpAttempts, limits.inputTokens, limits.outputTokens, limits.wallClockMs].every(value => value > 0), limits)
  check('envelope-covers-per-cell', limits.httpAttempts >= perCell.requests * cells.length
    && limits.inputTokens >= perCell.inputTokens * cells.length
    && limits.outputTokens >= perCell.outputTokens * cells.length
    && limits.wallClockMs >= perCell.wallClockMs * cells.length, { perCell, limits })
  check('design-matches-cells', design.design?.cells === 36 && design.design?.validation?.uniqueTaskArmBudget === 36, design.design?.validation)

  const failed = checks.filter(entry => entry.pass !== true)
  const verdict = failed.length === 0 ? 'ready-for-authorization' : 'blocked'
  const output = {
    schemaVersion: 1,
    work: 'EF-R4 budget-sensitivity manifest preflight',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    verdict,
    executionAuthorized: false,
    providerCalls: 0,
    manifest: { path: `eval/e2e/out/manifest-${CAMPAIGN}.json`, sha256: manifestSha },
    authorization: { path: `eval/e2e/out/authorization-${CAMPAIGN}.json`, sha256: authorizationSha, granted: authorization.granted },
    code: { head: git('rev-parse', 'HEAD'), sourceTreeDigest: sourceDigest, worktreeClean: dirty.length === 0 },
    checks,
    failed: failed.map(entry => entry.id),
    nextStep: failed.length === 0
      ? 'A new explicit live authorization must set granted=true in the authorization and keep the manifest SHA. A representative transport health probe must pass first.'
      : 'Fix the failed checks and re-freeze; do not request a live grant.',
    note: 'No live route was resolved and no credential was read. This preflight is not an authorization.',
  }
  const preflightPath = join(OUT, 'budget-manifest-preflight.json')
  writeFileSync(preflightPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  pointer.preflight = {
    path: 'eval/r4/out/budget-manifest-preflight.json',
    sha256: sha256File(preflightPath),
    verdict,
    generatedAt: output.generatedAt,
  }
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

  process.stdout.write(`budget-manifest-preflight: ${verdict}; ${checks.length - failed.length}/${checks.length} checks\n`)
  for (const entry of failed) process.stderr.write(`  FAILED ${entry.id}: ${JSON.stringify(entry.detail)}\n`)
  process.stdout.write(`wrote ${preflightPath}\n`)
  if (failed.length > 0) process.exit(1)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('preflight-budget-manifest.mjs')) main()
