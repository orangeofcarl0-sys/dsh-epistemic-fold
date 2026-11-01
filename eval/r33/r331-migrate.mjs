#!/usr/bin/env node
/**
 * R33.1 dataset migration: v1 -> v2.
 *
 * This is an AUDIT script, not a silent rewrite. It does three things:
 *
 *  1. preserves the R33 v1 manifest and its reports under `eval/r33/frozen/v1/`
 *     (the case bytes themselves remain in Git at `ad2...0d`);
 *  2. adds the checks the evaluator now needs: `checker.expectedChecks`,
 *     `requiresTests`, and the v2 schema version;
 *  3. moves a citation that does not contain the quoted evidence into
 *     `corroboratingRefs`, because v2 requires the quote in EVERY `sourceRef`.
 *
 * Run: node eval/r33/r331-migrate.mjs && node eval/r33/freeze.mjs
 *
 * @module eval/r33/r331-migrate
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CASES = join(HERE, 'cases')
const FROZEN_V1 = join(HERE, 'frozen', 'v1')

async function preserveV1() {
  await mkdir(join(FROZEN_V1, 'reports'), { recursive: true })
  const copies = [
    [join(HERE, 'manifest.json'), join(FROZEN_V1, 'manifest.json')],
    [join(HERE, 'out', 'offline-report.json'), join(FROZEN_V1, 'reports', 'offline-report.json')],
    [join(HERE, 'out', 'offline-report.md'), join(FROZEN_V1, 'reports', 'offline-report.md')],
    [join(HERE, 'out', 'self-test-report.json'), join(FROZEN_V1, 'reports', 'self-test-report.json')],
    [join(HERE, 'out', 'live-report.json'), join(FROZEN_V1, 'reports', 'live-report.json')],
    [join(HERE, 'out', 'live-check.json'), join(FROZEN_V1, 'reports', 'live-check.json')],
  ]
  for (const [from, to] of copies) {
    await copyFile(from, to).catch(() => undefined)
  }
  await writeFile(join(FROZEN_V1, 'README.md'), [
    '# R33 dataset v1 (preserved)',
    '',
    'These are the R33 artifacts exactly as published. The case bytes for v1 are',
    'preserved in Git at commit `ad3020df0e22587f78490c19550fe6986f55af3f`; this',
    'directory keeps the manifest and reports reachable without a checkout.',
    '',
    'The current `eval/r33/cases/` tree is dataset **v2**. The v1 -> v2 changes are:',
    '',
    '- `checker.expectedChecks` added, so the harness can reject missing, duplicate,',
    '  or invented checks;',
    '- `requiresTests` added, so skipping the requested visible test run is a',
    '  separate process violation;',
    '- three gold facts now cite their authoritative message in `sourceRefs` and',
    '  their corroborating message in `corroboratingRefs` (the quote must occur in',
    '  every authoritative citation);',
    '- the scorer moved from v1 (coordinate fallback) to v2 (exact claim + source',
    '  support). Old and new numbers are compared in `R34_EVALUATOR_AUDIT.md`.',
    '',
    'No transcript, task, gold statement, action, or hidden assertion was changed.',
    '',
  ].join('\n'), 'utf8')
}

/** The exact citation corrections, by case and fact id. */
const CITATION_FIXES = {
  B2: { 'B2-memory': { sourceRefs: [0], corroboratingRefs: [2] } },
  C1: { 'C1-fs-watch-rejected': { sourceRefs: [2], corroboratingRefs: [1] } },
  D1: { 'D1-not-run': { sourceRefs: [2], corroboratingRefs: [3] } },
}

async function main() {
  await preserveV1()
  const ids = (await readdir(CASES, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  const summary = []
  for (const id of ids) {
    const path = join(CASES, id, 'case.json')
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    const checkerSource = await readFile(join(CASES, id, 'check.mjs'), 'utf8')
    const expectedChecks = [...checkerSource.matchAll(/\bcheck\('([^']+)'/gu)].map(match => match[1])
    if (expectedChecks.length === 0) throw new Error(`${id}: no check('name') calls found`)
    const fixes = CITATION_FIXES[id] ?? {}
    const gold = metadata.gold.map(fact => {
      const fix = fixes[fact.factId]
      if (fix === undefined) return fact
      return { ...fact, ...fix }
    })
    const migrated = {
      ...metadata,
      schemaVersion: 2,
      requiresTests: true,
      ...(metadata.counterfactual === undefined ? {} : { counterfactual: metadata.counterfactual }),
      gold,
      checker: { ...(metadata.checker ?? {}), expectedChecks },
    }
    await writeFile(path, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8')
    summary.push({ id, checks: expectedChecks.length, citationFixes: Object.keys(fixes).length })
  }
  process.stdout.write(`${JSON.stringify({
    migrated: summary.length,
    checks: summary.reduce((sum, entry) => sum + entry.checks, 0),
    citationFixes: summary.reduce((sum, entry) => sum + entry.citationFixes, 0),
    preserved: FROZEN_V1,
  }, null, 2)}\n`)
}

await main()
