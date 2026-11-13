#!/usr/bin/env node
/**
 * EF-C1 WP0 — the protected-artifact registry.
 *
 * ## Why this exists
 *
 * EF-C0 found that running the ordinary Vitest suite rewrites tracked evidence:
 * the R1 report generator, the R33 offline report and the R33 live gate all
 * wrote their outputs into the repository as a side effect of being tested.
 * A `git status` after the run looked clean only because the changed files had
 * been restored by hand.
 *
 * This script answers "what is protected, and what is it right now" without
 * running anything. It hashes each protected path TWICE:
 *
 *   headSha256      the blob git stores (`git cat-file blob HEAD:<path>`)
 *   worktreeSha256  the bytes on disk
 *
 * Two hashes on purpose. A manifest that hashes only the working tree verifies
 * on the machine that generated it and mismatches on every other checkout
 * (CRLF vs LF) — the defect `tests/docs-manifest.spec.ts` documents. The HEAD
 * hash is the authority; the worktree hash says whether this checkout has
 * drifted from it.
 *
 * ## Categories
 *
 * Not every protected path is the same kind of thing, and the brief requires
 * the difference to be recorded rather than flattened:
 *
 *   frozen                  historical evidence that must never be rewritten
 *   historical-report       a report whose committed bytes are the record
 *   tracked-convenience-copy  a latest/ copy that a run-scoped record supersedes
 *   generated-configuration   a file generated from inputs; may be regenerated
 *                             deliberately, never by a test
 *
 * The rule all four share: an ordinary test must not write it.
 *
 * @module eval/c1/protected-artifacts
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

/**
 * The explicit registry.
 *
 * `writer` names the code that CAN write the path, `trigger` names the command
 * that runs that code. A path with `writer: null` has no writer in the tree and
 * is protected against accidental edits only.
 */
const REGISTRY = [
  {
    path: 'docs/12_R1_EVALUATION_REPORT.md',
    category: 'historical-report',
    authority: 'the committed bytes are the R1 record',
    writer: 'tests/r1-report.spec.ts',
    trigger: 'npx vitest run tests/r1-report.spec.ts (also inside the full suite)',
    defaultBehavior: 'rewritten unconditionally at the end of the test',
    safeOverride: 'none before EF-C1',
    risk: 'high',
  },
  {
    path: 'docs/MANIFEST.json',
    category: 'generated-configuration',
    authority: 'the committed manifest describes the committed docs',
    writer: 'tests/r1-report.spec.ts',
    trigger: 'npx vitest run tests/r1-report.spec.ts',
    defaultBehavior: 'regenerated from the docs directory at the end of the test',
    safeOverride: 'none before EF-C1',
    risk: 'high',
  },
  {
    path: 'cordis.patch.yml',
    category: 'generated-configuration',
    authority: 'the checked-in block is what a release ships',
    writer: 'scripts/generate-presets.mjs',
    trigger: 'npm ci / npm install / npm pack (via `prepare`)',
    defaultBehavior: 'rewritten when an installed DSH home is found',
    safeOverride: 'none before EF-C1',
    risk: 'high',
  },
  {
    path: 'scripts/vendor-paths.json',
    category: 'generated-configuration',
    authority: 'the vitest alias table is derived from the vendor tsconfig',
    writer: 'scripts/generate-maps.cjs',
    trigger: 'node scripts/generate-maps.cjs (CI runs it, then git diff --exit-code)',
    defaultBehavior: 'rewritten unconditionally',
    safeOverride: 'none before EF-C1',
    risk: 'medium',
  },
  {
    path: 'scripts/vendor-types-paths.json',
    category: 'generated-configuration',
    authority: 'the tsconfig path map is derived from the vendor tsconfig',
    writer: 'scripts/generate-maps.cjs',
    trigger: 'node scripts/generate-maps.cjs',
    defaultBehavior: 'rewritten unconditionally',
    safeOverride: 'none before EF-C1',
    risk: 'medium',
  },
  {
    path: 'tsconfig.json',
    category: 'generated-configuration',
    authority: 'compilerOptions.paths must match the vendored declarations',
    writer: 'scripts/generate-maps.cjs',
    trigger: 'node scripts/generate-maps.cjs',
    defaultBehavior: 'compilerOptions.paths replaced, rest preserved',
    safeOverride: 'none before EF-C1',
    risk: 'medium',
  },
  {
    path: 'eval/r33/out/live-report.json',
    category: 'tracked-convenience-copy',
    authority: 'a run-scoped report under R33_RUN_ROOT is the run record',
    writer: 'eval/r33/live.mjs writeReport()',
    trigger: 'node eval/r33/live.mjs --run without R33_LIVE (the gate refusal path)',
    defaultBehavior: 'the refusal record replaces the latest live report',
    safeOverride: 'R35_WRITE_LATEST=0 only covers writeRunReport, not the refusal path',
    risk: 'high',
  },
  {
    path: 'eval/r33/out/live-check.json',
    category: 'tracked-convenience-copy',
    authority: 'the interface check is reproducible; the committed copy is a snapshot',
    writer: 'eval/r33/live.mjs writeReport()',
    trigger: 'node eval/r33/live.mjs --check (run by tests/r33-live-entry.spec.ts)',
    defaultBehavior: 'rewritten with a fresh generatedAt on every check',
    safeOverride: 'none before EF-C1',
    risk: 'high',
  },
  {
    path: 'eval/r33/out/offline-report.json',
    category: 'historical-report',
    authority: 'the committed report is the offline arm-matrix record',
    writer: 'tests/r33-arms.spec.ts',
    trigger: 'npx vitest run tests/r33-arms.spec.ts (also inside the full suite)',
    defaultBehavior: 'rewritten at the end of the arm matrix test',
    safeOverride: 'none before EF-C1',
    risk: 'high',
  },
  {
    path: 'eval/r33/out/offline-report.md',
    category: 'historical-report',
    authority: 'the committed report is the offline arm-matrix record',
    writer: 'tests/r33-arms.spec.ts',
    trigger: 'npx vitest run tests/r33-arms.spec.ts',
    defaultBehavior: 'rewritten at the end of the arm matrix test',
    safeOverride: 'none before EF-C1',
    risk: 'high',
  },
  {
    path: 'eval/r33/out/self-test-report.json',
    category: 'historical-report',
    authority: 'the committed report records the scripted self-test run',
    writer: 'eval/r33/live.mjs writeReport()',
    trigger: 'node eval/r33/live.mjs --self-test (npm run eval:r33-self-test)',
    defaultBehavior: 'rewritten with a fresh generatedAt on every self-test',
    safeOverride: 'none before EF-C1',
    risk: 'medium',
  },
  {
    path: 'eval/r33/out/scorer-comparison.json',
    category: 'historical-report',
    authority: 'the committed comparison is the scorer record',
    writer: 'eval/r33/compare-scores.mjs',
    trigger: 'npm run eval:r33-compare (explicit generator, not a test)',
    defaultBehavior: 'rewritten when the generator is run',
    safeOverride: 'explicit command only',
    risk: 'low',
  },
]

/**
 * Evidence trees that are frozen wholesale — used only as a fallback when the
 * C0 artifact manifest is unavailable.
 */
const FROZEN_PREFIXES = ['eval/r31/', 'eval/r32/', 'eval/r33/', 'eval/r35/', 'eval/r36/', 'eval/r37/', 'eval/r37c/', 'eval/r37d/', 'eval/r38/']

/** Files that are frozen but do not sit under an evidence tree. */
const FROZEN_EXTRA = ['docs/convergence/data/git-stage-map.json', 'docs/convergence/data/artifact-manifest.json', 'docs/convergence/data/evidence-registry.json']

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: ROOT, encoding, maxBuffer: 64 * 1024 * 1024 })
}

function headBlob(path) {
  try {
    return git(['cat-file', 'blob', `HEAD:${path}`], 'buffer')
  } catch {
    return undefined
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isTracked(path) {
  try {
    return git(['ls-files', '--error-unmatch', '--', path]).trim().length > 0
  } catch {
    return false
  }
}

/** Every artifact the EF-C0 manifest classifies as evidence, minus explicit entries. */
function frozenFiles(explicit) {
  const out = []
  // The manifest is the authority: it names evidence and research documents,
  // not source code. A whole-directory prefix would freeze `eval/r33/live.mjs`
  // — the runner — alongside the reports it produces, which is a different kind
  // of thing and is allowed to change.
  const manifestPath = join(ROOT, 'docs', 'convergence', 'data', 'artifact-manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const artifact of manifest.artifacts ?? []) {
      if (typeof artifact.path !== 'string') continue
      if (explicit.has(artifact.path)) continue
      if (!isTracked(artifact.path)) continue
      out.push(artifact.path)
    }
  } else {
    for (const prefix of FROZEN_PREFIXES) {
      let listed = ''
      try {
        listed = git(['ls-files', '--', prefix])
      } catch {
        continue
      }
      for (const path of listed.split('\n')) {
        if (path.length === 0) continue
        if (explicit.has(path)) continue
        out.push(path)
      }
    }
  }
  for (const path of FROZEN_EXTRA) {
    if (isTracked(path) && !explicit.has(path)) out.push(path)
  }
  return [...new Set(out)].sort()
}

function main() {
  const explicit = new Set(REGISTRY.map(entry => entry.path))
  const rows = []

  for (const entry of REGISTRY) {
    const blob = headBlob(entry.path)
    const full = join(ROOT, entry.path)
    const present = existsSync(full)
    const worktree = present ? readFileSync(full) : undefined
    const normalizedWorktree = worktree === undefined
      ? undefined
      : Buffer.from(worktree.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')
    rows.push({
      ...entry,
      tracked: isTracked(entry.path),
      present,
      bytes: worktree?.length ?? 0,
      headSha256: blob === undefined ? null : sha256(blob),
      worktreeSha256: normalizedWorktree === undefined ? null : sha256(normalizedWorktree),
      worktreeMatchesHead: blob !== undefined && normalizedWorktree !== undefined
        && sha256(blob) === sha256(normalizedWorktree),
      rawWorktreeSha256: worktree === undefined ? null : sha256(worktree),
    })
  }

  const frozen = frozenFiles(explicit).map(path => {
    const blob = headBlob(path)
    const full = join(ROOT, path)
    const present = existsSync(full)
    const worktree = present ? readFileSync(full) : undefined
    const normalized = worktree === undefined
      ? undefined
      : Buffer.from(worktree.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')
    return {
      path,
      category: 'frozen',
      tracked: true,
      present,
      bytes: worktree?.length ?? 0,
      headSha256: blob === undefined ? null : sha256(blob),
      worktreeSha256: normalized === undefined ? null : sha256(normalized),
      worktreeMatchesHead: blob !== undefined && normalized !== undefined
        && sha256(blob) === sha256(normalized),
      rawWorktreeSha256: worktree === undefined ? null : sha256(worktree),
    }
  })

  const byCategory = {}
  for (const row of [...rows, ...frozen]) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + 1
  }

  const drifted = [...rows, ...frozen].filter(row => !row.worktreeMatchesHead)
  // Generated configuration may be deliberately ahead of HEAD during a round
  // (the docs manifest is regenerated after a doc edit). Evidence and
  // convenience copies may not: those are the paths an ordinary test must never
  // touch, so their drift is the gate.
  const isGenerated = (row) => row.category === 'generated-configuration'
  const driftedFrozen = drifted.filter(row => !isGenerated(row))
  const driftedGenerated = drifted.filter(isGenerated)

  const report = {
    schemaVersion: 1,
    work: 'EF-C1',
    generator: 'eval/c1/protected-artifacts.mjs',
    sourceCommit: git(['rev-parse', 'HEAD']).trim(),
    generatedAt: new Date().toISOString(),
    root: ROOT,
    rule: 'an ordinary test must not write a protected path',
    counts: {
      explicit: rows.length,
      frozen: frozen.length,
      total: rows.length + frozen.length,
      byCategory,
      drifted: drifted.length,
      driftedFrozen: driftedFrozen.length,
      driftedGenerated: driftedGenerated.length,
    },
    entries: [...rows, ...frozen],
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'protected-artifacts.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `protected artifacts: ${report.counts.total} `
    + `(${rows.length} explicit, ${frozen.length} frozen), `
    + `${driftedFrozen.length} frozen drift(s), ${driftedGenerated.length} generated-config drift(s)\n`,
  )
  for (const row of driftedFrozen) process.stdout.write(`  frozen drift: ${row.path}\n`)
  for (const row of driftedGenerated) process.stdout.write(`  generated drift: ${row.path}\n`)
  process.stdout.write(`wrote ${join(OUT, 'protected-artifacts.json')}\n`)
}

main()
