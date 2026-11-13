#!/usr/bin/env node
/**
 * EF-C1A hard gate — A0..A5.
 *
 * The C1A half is the evidence foundation. C1B (DSH/Basic/baseline) may not be
 * trusted until these hold, so they are evaluated separately from the main
 * C1-G0..G7 gates and written to their own file.
 *
 * @module eval/c1/c1a-gate
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const DATA = join(ROOT, 'docs', 'convergence', 'data')

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined)
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

function check(id, name, ok, detail) {
  return { id, name, status: ok ? 'passed' : 'failed', detail }
}

function main() {
  const tests = readJson(join(OUT, 'c1-tests.json'))
  const registry = readJson(join(OUT, 'protected-artifacts.json'))
  const inventory = readJson(join(OUT, 'side-effect-inventory.json'))
  const accounting = readJson(join(OUT, 'test-accounting.json'))
  const baselines = readJson(join(DATA, 'report-baselines.json'))
  const pkg = readJson(join(ROOT, 'package.json'))

  const observations = ['post-npm-ci', 'post-r1-report', 'post-r33-arms', 'post-r33-live-entry']
    .map(id => readJson(join(OUT, `observation-${id}.json`)))

  const checks = []

  // A0 — baseline verified
  {
    const base = '327598f342dfca4fab2a779442af56a9ab510ece'
    const branch = git(['branch', '--show-current'])
    let ancestor = true
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: ROOT })
    } catch {
      ancestor = false
    }
    checks.push(check('A0', 'baseline verified',
      branch === 'chore/ef-c1-evaluation-foundation' && ancestor,
      `branch ${branch}, base ${base.slice(0, 12)} is an ancestor: ${ancestor}`))
  }

  // A1 — protected artifacts identified
  {
    const paths = new Set((registry?.entries ?? []).map(row => row.path))
    const required = [
      'docs/12_R1_EVALUATION_REPORT.md',
      'docs/MANIFEST.json',
      'cordis.patch.yml',
      'eval/r33/out/live-report.json',
      'eval/r33/out/offline-report.json',
    ]
    const missing = required.filter(path => !paths.has(path))
    checks.push(check('A1', 'protected artifacts identified',
      registry !== undefined && registry.counts.total >= 287 && missing.length === 0,
      `${registry?.counts.total ?? 'missing'} protected path(s); missing ${missing.join(', ') || 'none'}`))
  }

  // A2 — ordinary tests do not overwrite historical evidence
  {
    const observed = observations.every(row => row !== undefined && row.drifted === 0)
    const testNames = (tests?.testResults ?? []).map(row => row.name.replace(/\\/gu, '/'))
    const isolationRan = testNames.some(name => name.endsWith('tests/c1-evidence-isolation.spec.ts'))
    checks.push(check('A2', 'ordinary tests do not overwrite historical evidence',
      observed && isolationRan && tests?.success === true,
      `${observations.filter(row => row?.drifted === 0).length}/4 post observations at 0 drift, `
      + `isolation test ran ${isolationRan}, C1 tests success ${tests?.success}`))
  }

  // A3 — report generation is explicit
  {
    const scripts = pkg?.scripts ?? {}
    const commands = [
      'eval:r1-report:generate',
      'eval:r1-report:write',
      'eval:r33-offline-report',
      'eval:docs-manifest:write',
      'generate-presets:write',
    ]
    const missing = commands.filter(name => scripts[name] === undefined)
    const presets = readFileSync(join(ROOT, 'scripts', 'generate-presets.mjs'), 'utf8')
    const maps = readFileSync(join(ROOT, 'scripts', 'generate-maps.cjs'), 'utf8')
    const manifest = readFileSync(join(ROOT, 'scripts', 'generate-docs-manifest.mjs'), 'utf8')
    const flags = presets.includes('--check') && presets.includes('--output') && presets.includes('--write')
      && maps.includes('--check') && maps.includes('--output')
      && manifest.includes('--output') && manifest.includes('--write')
    checks.push(check('A3', 'report generation is explicit',
      missing.length === 0 && flags,
      `missing commands: ${missing.join(', ') || 'none'}; verify/generate/promote flags present: ${flags}`))
  }

  // A4 — test identity accounting is consistent or honestly bounded
  {
    const arithmetic = accounting?.arithmetic
    const declared = pkg?.devDependencies?.['@deepseek-ai/dsh-agent-loop']
    checks.push(check('A4', 'test identity accounting is consistent',
      arithmetic?.check === true && arithmetic.net === 24 && declared !== undefined,
      arithmetic === undefined
        ? 'no accounting'
        : `net ${arithmetic.net} = ${arithmetic.added} added - ${arithmetic.missing} missing; `
          + `agent-loop declared ${declared ?? 'no'}`))
  }

  // A5 — no new Core regressions
  {
    const same = accounting?.failures?.same === true
    const noStatusChange = (accounting?.changedStatus ?? []).length === 0
    checks.push(check('A5', 'no new Core regressions',
      same && noStatusChange,
      `same failure set across R38/C0: ${same}; status changes ${accounting?.changedStatus?.length ?? '?'}`))
  }

  // A4 also depends on the report baselines being declared, not silently stale.
  const reportBaselinesOk = (baselines?.reports ?? []).length >= 4
    && baselines.reports.every(row =>
      ['current', 'stale', 'superseded'].includes(row.status)
      && (row.status !== 'stale' || (typeof row.cause === 'string' && row.cause.length > 0)))

  const report = {
    schemaVersion: 1,
    work: 'EF-C1A',
    generatedAt: new Date().toISOString(),
    sourceCommit: git(['rev-parse', 'HEAD']),
    checks,
    reportBaselinesDeclared: reportBaselinesOk,
    inventoryUncovered: inventory?.scan?.uncoveredRepoFiles?.length ?? 'missing',
    passed: checks.filter(row => row.status === 'passed').length,
    failed: checks.filter(row => row.status === 'failed').length,
    eligible: checks.every(row => row.status === 'passed') && reportBaselinesOk,
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'c1a-gate.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  for (const row of checks) process.stdout.write(`${row.id}  ${row.status.padEnd(7)} ${row.name} — ${row.detail}\n`)
  process.stdout.write(`C1A eligible: ${report.eligible}\n`)
  process.exit(report.eligible ? 0 : 1)
}

main()
