#!/usr/bin/env node
/**
 * EF-R3 product-lane — cost-completeness preflight.
 *
 * R2 treated a checker result as sufficient even when a request had no usage.
 * The product pilot separates the axes and sets `strictUsage: true`: the runner
 * stops on any `unknownUsage` instead of carrying an incomplete cost ledger.
 *
 *   node eval/r3/cost-preflight.mjs [--manifest eval/e2e/out/manifest-e2e-r3-product-pilot-1.json]
 *
 * @module eval/r3/cost-preflight
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const manifestPath = value('manifest', join(ROOT, 'eval', 'e2e', 'out', 'manifest-e2e-r3-product-pilot-1.json'))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const ledgerPath = join(OUT, 'cell-ledger.json')
if (!existsSync(ledgerPath)) {
  process.stderr.write('cost-preflight: run eval/r3/reconcile-confirm.mjs first\n')
  process.exit(2)
}
const ledger = readJson(ledgerPath)
const historical = {
  confirm: {
    valid: ledger.confirm.summary.valid,
    costInvalid: ledger.confirm.summary.costInvalidCells.length,
    cells: ledger.confirm.summary.costInvalidCells,
  },
  pilot: {
    valid: ledger.pilot.summary.valid,
    costInvalid: ledger.pilot.summary.costInvalidCells.length,
    cells: ledger.pilot.summary.costInvalidCells,
  },
}

const runnerPath = join(ROOT, 'eval', 'e2e', 'src', 'run.mjs')
const runnerText = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : ''
const runnerEnforcesStrictUsage = /strictUsage/u.test(runnerText)
  && /provider-usage-incomplete/u.test(runnerText)

let manifest = null
let manifestChecks = null
if (existsSync(manifestPath)) {
  const body = readJson(manifestPath)
  manifest = { path: manifestPath.replace(ROOT, '').replace(/\\/gu, '/'), sha256: sha256(manifestPath) }
  manifestChecks = {
    strictUsage: body.config?.strictUsage === true,
    framingMode: body.config?.framingMode === 'system-dedup',
    retainRatio: body.config?.retainRatio === 0.16,
    operationalBudgetTokens: body.config?.operationalBudgetTokens === 32_768,
    rationaleHintTokens: body.config?.rationaleHintTokens === 400,
    cells: body.cells?.length === 18,
    tasks: body.tasks?.length === 6,
    arms: new Set((body.cells ?? []).map(cell => cell.arm)).size === 3,
    basicNativeRetention: body.config?.basic?.retainRatio === null,
  }
}

const manifestPass = manifestChecks !== null
  && Object.values(manifestChecks).every(Boolean)
  && runnerEnforcesStrictUsage
const status = manifestChecks === null
  ? 'manifest-missing'
  : manifestPass ? 'pass' : 'fail'

const output = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane',
  generatedAt: new Date().toISOString(),
  historical,
  productManifest: manifest,
  manifestChecks,
  runnerEnforcesStrictUsage,
  rule: {
    strictUsage: true,
    stopReason: 'provider-usage-incomplete',
    note: 'A cell with any unknown usage is recorded as executed but cost-invalid; the runner stops the campaign instead of continuing.',
  },
  status,
  note: status === 'manifest-missing'
    ? 'Historical cost completeness is recorded; the product pilot manifest is not frozen yet.'
    : 'The product pilot requires strict usage on every request. No usage is imputed.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'cost-preflight.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`cost preflight: ${status}; historical confirm ${historical.confirm.costInvalid}/${historical.confirm.valid} cost-invalid, pilot ${historical.pilot.costInvalid}/${historical.pilot.valid}\n`)
if (manifestChecks !== null) process.stdout.write(`  manifest checks ${JSON.stringify(manifestChecks)}; runner strictUsage=${runnerEnforcesStrictUsage}\n`)
process.stdout.write(`wrote ${path}\n`)
if (status === 'fail') process.exit(1)
