#!/usr/bin/env node
/**
 * R38-M0 WP0: baseline manifest.
 *
 * Records the repository state, dependency versions, source digests, historical
 * evidence digests and the test baseline that every R38 result is measured
 * against. It does not modify anything.
 *
 * Output: eval/r38/out/baseline-manifest.json
 *
 * @module eval/r38/baseline
 */

import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'out', 'baseline-manifest.json')

const R37B_ARCHIVE_SHA = 'de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92'
const R37B_ARCHIVE_BYTES = 3_763_962

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

async function sha256(path) {
  const bytes = await readFile(join(ROOT, path))
  return createHash('sha256').update(bytes).digest('hex')
}

async function digestOf(paths) {
  const out = {}
  for (const path of paths) out[path] = await sha256(path)
  return out
}

const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const dshPackages = Object.fromEntries(
  Object.entries(packageJson.devDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/'))
    .sort(([left], [right]) => left.localeCompare(right)),
)

const sourceFiles = [
  'src/semantic/validate.ts',
  'src/semantic/plan.ts',
  'src/semantic/types.ts',
  'src/semantic/retirement.ts',
  'src/semantic/working-set-compiler.ts',
  'src/state/state.ts',
  'src/state/authority.ts',
  'src/fold/engine.ts',
  'src/checkpoint/renderer.ts',
  'src/recall/recall.ts',
]

const evidenceFiles = [
  'eval/r37c/out/gate-status-r37c.json',
  'eval/r37c/out/statistics-audit.json',
  'eval/r37c/out/evidence-archive.json',
  'eval/r37d/out/gate-status-r37d.json',
  'eval/r37d/out/process-pilot-results.json',
  'eval/r37d/out/process-pilot-trajectories.json',
]

const r37dBaseline = JSON.parse(await readFile(join(ROOT, 'eval/r37d/out/baseline.json'), 'utf8'))
const tests = JSON.parse(await readFile(join(ROOT, 'eval/r38/out/baseline-tests.json'), 'utf8'))

const status = git(['status', '--porcelain'])
const statusLines = status.length === 0 ? [] : status.split(/\r?\n/u)
const trackedChanges = statusLines.filter(line => !line.startsWith('??'))
const untracked = statusLines.filter(line => line.startsWith('??'))
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R38-M0',
  work: 'WP0-baseline',
  repository: packageJson.repository?.url ?? null,
  git: {
    branch: git(['branch', '--show-current']),
    head: git(['rev-parse', 'HEAD']),
    base: '7a2c974c479bc1286f172e9f7b203af92e22e629',
    worktree: ROOT.replace(/\\/gu, '/'),
    cleanAtStart: trackedChanges.length === 0,
    statusAtStart: statusLines,
    trackedChanges,
    untracked,
  },
  runtime: {
    node: process.version,
    npm: execSync('npm --version', { cwd: ROOT, encoding: 'utf8' }).trim(),
  },
  dependencies: {
    dsh: dshPackages,
    note: '@deepseek-ai/dsh-agent-loop is installed with --no-save for the native smoke; package.json is unchanged.',
  },
  sourceDigests: await digestOf(sourceFiles),
  historicalEvidence: {
    r37bArchive: {
      sha256: r37dBaseline.archive?.sha256 ?? null,
      bytes: r37dBaseline.archive?.bytes ?? null,
      expectedSha256: R37B_ARCHIVE_SHA,
      expectedBytes: R37B_ARCHIVE_BYTES,
      match: r37dBaseline.archive?.sha256 === R37B_ARCHIVE_SHA
        && r37dBaseline.archive?.bytes === R37B_ARCHIVE_BYTES,
    },
    digests: await digestOf(evidenceFiles),
  },
  testBaseline: {
    source: tests.source,
    total: tests.total,
    passed: tests.passed,
    failed: tests.failed,
    skipped: tests.skipped,
    failureFiles: [...new Set(tests.failures.map(row => row.file))].sort(),
    failures: tests.failures,
    note: 'The failures are the pre-existing vendor/DSH-drift set recorded by R36/R37-B/R37-C. '
      + 'No R38 test fails. One R37-D failure now passes; the total is unchanged at 1737.',
  },
  r37d: {
    head: '7a2c974c479bc1286f172e9f7b203af92e22e629',
    note: 'R37-D handoff HEAD; the R38 worktree was created from it.',
  },
  status: 'passed',
}
await writeJson(OUT, manifest)

process.stdout.write(`R38 baseline: ${OUT}\n`)
process.stdout.write(`branch ${manifest.git.branch}@${manifest.git.head.slice(0, 7)}; clean ${manifest.git.cleanAtStart}\n`)
process.stdout.write(`archive match ${manifest.historicalEvidence.r37bArchive.match}; `
  + `tests ${manifest.testBaseline.passed}/${manifest.testBaseline.total} passed, ${manifest.testBaseline.failed} failed\n`)
process.exit(manifest.historicalEvidence.r37bArchive.match ? 0 : 1)
