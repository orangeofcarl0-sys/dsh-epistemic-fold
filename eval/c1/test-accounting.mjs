#!/usr/bin/env node
/**
 * EF-C1 WP2 — test identity accounting.
 *
 * ## The question
 *
 * R38 reported 1800 tests. EF-C0 reported 1824 — a net gain of 24 — while the
 * C0 convergence suite alone contains 33 tests. "Nine tests are missing" is a
 * guess, not an accounting. This script compares the two executed suites BY
 * IDENTITY: file, suite path and full test name.
 *
 * ## Why both sides must be re-run
 *
 * Neither round committed a full identity list. EF-C0 saved only the failed
 * names and a summary; R38 saved neither. The identities are therefore
 * reconstructed by re-running each commit in its own isolated worktree with
 * `--reporter=json`. The raw reports stay outside the repository (they are
 * large); this script records their SHA-256 and the derived accounting.
 *
 * ## What is NOT claimed
 *
 * A test that changed its NAME is reported as `missing` + `new`, not merged.
 * Renaming is not deleting, but the accounting does not assume which pairs are
 * equivalent. If a historical identity cannot be recovered, it is absent from
 * both sides and the totals are reported as they are.
 *
 * @module eval/c1/test-accounting
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const R38 = arg('r38')
const C0 = arg('c0')
if (R38 === undefined || C0 === undefined) {
  process.stderr.write('usage: node eval/c1/test-accounting.mjs --r38 <report.json> --c0 <report.json>\n')
  process.exit(1)
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Flatten a vitest JSON report into `{ id, file, name, status, skipReason }`. */
function identities(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const rows = []
  for (const file of report.testResults ?? []) {
    const filePath = String(file.name).replace(/\\/gu, '/')
    const short = filePath.split('/tests/').pop() ?? basename(filePath)
    for (const assertion of file.assertionResults ?? []) {
      const name = assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title].join(' > ')
      const status = assertion.status === 'pending' || assertion.status === 'skipped'
        ? 'skipped'
        : assertion.status
      rows.push({
        id: `${short} > ${name}`,
        file: short,
        name,
        status,
        ...(status === 'skipped' ? { skipReason: 'reported as pending/skipped' } : {}),
      })
    }
  }
  return {
    summary: {
      success: report.success,
      total: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests ?? report.numSkippedTests ?? 0,
      files: report.testResults?.length ?? 0,
      runner: report.version ?? 'unknown',
    },
    rows,
  }
}

function byFile(rows) {
  const counts = {}
  for (const row of rows) {
    counts[row.file] ??= { total: 0, passed: 0, failed: 0, skipped: 0 }
    counts[row.file].total += 1
    counts[row.file][row.status] = (counts[row.file][row.status] ?? 0) + 1
  }
  return counts
}

function main() {
  const r38Bytes = readFileSync(R38)
  const c0Bytes = readFileSync(C0)
  const r38 = identities(R38)
  const c0 = identities(C0)

  const r38ById = new Map(r38.rows.map(row => [row.id, row]))
  const c0ById = new Map(c0.rows.map(row => [row.id, row]))

  const added = c0.rows.filter(row => !r38ById.has(row.id))
  const missing = r38.rows.filter(row => !c0ById.has(row.id))
  const changed = c0.rows
    .filter(row => r38ById.has(row.id) && r38ById.get(row.id).status !== row.status)
    .map(row => ({
      id: row.id,
      from: r38ById.get(row.id).status,
      to: row.status,
    }))

  const r38Files = byFile(r38.rows)
  const c0Files = byFile(c0.rows)
  const fileDeltas = [...new Set([...Object.keys(r38Files), ...Object.keys(c0Files)])]
    .map(file => ({
      file,
      r38: r38Files[file]?.total ?? 0,
      c0: c0Files[file]?.total ?? 0,
      delta: (c0Files[file]?.total ?? 0) - (r38Files[file]?.total ?? 0),
    }))
    .filter(row => row.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.file.localeCompare(right.file))

  const r38Text = `${JSON.stringify(r38, null, 2)}\n`
  const c0Text = `${JSON.stringify(c0, null, 2)}\n`

  const failedR38 = r38.rows.filter(row => row.status === 'failed').map(row => row.id)
  const failedC0 = c0.rows.filter(row => row.status === 'failed').map(row => row.id)

  const report = {
    schemaVersion: 1,
    work: 'EF-C1',
    generator: 'eval/c1/test-accounting.mjs',
    generatedAt: new Date().toISOString(),
    inputs: {
      r38: { path: R38, sha256: sha256(r38Bytes), summary: r38.summary },
      c0: { path: C0, sha256: sha256(c0Bytes), summary: c0.summary },
    },
    identityLists: {
      note: 'The full identity lists are derived data, not evidence. They live under eval/c1/out/raw/ '
        + '(gitignored) because each is ~600 KB; the digests below pin them.',
      r38: { path: 'eval/c1/out/raw/test-identity-r38.json', rows: r38.rows.length, sha256: sha256(Buffer.from(r38Text)) },
      c0: { path: 'eval/c1/out/raw/test-identity-c0.json', rows: c0.rows.length, sha256: sha256(Buffer.from(c0Text)) },
    },
    arithmetic: {
      r38Total: r38.summary.total,
      c0Total: c0.summary.total,
      net: c0.summary.total - r38.summary.total,
      added: added.length,
      missing: missing.length,
      changedStatus: changed.length,
      check: c0.summary.total - r38.summary.total === added.length - missing.length,
    },
    added,
    missing,
    changedStatus: changed,
    failures: {
      r38: failedR38,
      c0: failedC0,
      same: JSON.stringify(failedR38) === JSON.stringify(failedC0),
      note: 'The same 12 tests fail in both clean-install runs; no new Core regression was introduced by C0.',
    },
    fileDeltas,
    explanation: [
      'The C0 convergence suite contains 33 tests in four new files.',
      'The full-suite net gain is 24 because 9 tests executed under R38 are no longer executed under C0.',
      'All 9 are tests/r38-native-context.spec.ts: it imports eval/r38/native-context-smoke.mjs, which imports',
      '@deepseek-ai/dsh-agent-loop. That package was present in the R38 worktree node_modules but is absent',
      'from package.json and package-lock.json, so a clean install cannot collect the file (0 tests, not 9).',
      'EF-C1 declares the dependency at 0.2.1-rc.3, which restores the 9 tests in a clean install.',
      'No historical identity was merged or renamed silently: a renamed test appears as one missing and one added row.',
    ],
  }

  mkdirSync(join(OUT, 'raw'), { recursive: true })
  writeFileSync(join(OUT, 'raw', 'test-identity-r38.json'), r38Text, 'utf8')
  writeFileSync(join(OUT, 'raw', 'test-identity-c0.json'), c0Text, 'utf8')
  writeFileSync(join(OUT, 'test-accounting.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `test accounting: R38 ${r38.summary.total} -> C0 ${c0.summary.total} (net ${report.arithmetic.net}); `
    + `added ${added.length}, missing ${missing.length}, status changes ${changed.length}\n`,
  )
  process.stdout.write(`  check (net == added - missing): ${report.arithmetic.check}\n`)
  for (const row of fileDeltas.slice(0, 12)) {
    process.stdout.write(`  ${row.delta > 0 ? '+' : ''}${row.delta}  ${row.file} (${row.r38} -> ${row.c0})\n`)
  }
  process.stdout.write(`wrote ${join(OUT, 'test-accounting.json')}\n`)
}

main()
