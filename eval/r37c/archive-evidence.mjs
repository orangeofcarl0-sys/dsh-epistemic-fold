#!/usr/bin/env node
/**
 * R37-C0-A: immutable local archive of the R37-B raw evidence.
 *
 * The archive is written OUTSIDE the git worktree so a later checkout, clean,
 * or worktree removal cannot destroy it. Before archiving, every text artifact
 * is scanned for credential-shaped strings. The archive is refused if a
 * finding is present; no API key or Authorization header is ever copied.
 *
 *   node eval/r37c/archive-evidence.mjs
 *
 * Env:
 *   R37C_R37_ROOT      R37-B `eval/r37` directory
 *   R37C_ARCHIVE_DIR   destination directory (default: sibling of the repo)
 *
 * @module eval/r37c/archive-evidence
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, sha256File, walkFiles, writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R37_ROOT = process.env.R37C_R37_ROOT === undefined
  ? resolve(ROOT, '..', 'ef-r37-action', 'eval', 'r37')
  : resolve(process.env.R37C_R37_ROOT)
const ARCHIVE_DIR = process.env.R37C_ARCHIVE_DIR === undefined
  ? resolve(ROOT, '..', 'ef-r37c-evidence-archive')
  : resolve(process.env.R37C_ARCHIVE_DIR)
const OUT = join(HERE, 'out', 'evidence-archive.json')
const STAMP = '20261106'
const ARCHIVE_PATH = join(ARCHIVE_DIR, `r37b-raw-evidence-${STAMP}.tar.gz`)

const SOURCES = [
  { name: 'runs-b', path: join(R37_ROOT, 'runs-b') },
  { name: 'runs-b2', path: join(R37_ROOT, 'runs-b2') },
  { name: 'manifests-b', path: join(R37_ROOT, 'manifests-b') },
  { name: 'manifests-b2', path: join(R37_ROOT, 'manifests-b2') },
]
const AUTHORITATIVE = [
  'eval/r37/out/r37b-results.json',
  'eval/r37/out/r37b-stage2-results.json',
  'eval/r37/out/r37b-stage2-statistics.json',
  'eval/r37/out/gate-status-r37b.json',
  'eval/r37/out/gate-status-r37b-stage2.json',
]

const SECRET_PATTERNS = [
  { name: 'openai-key', expression: /sk-[A-Za-z0-9_-]{20,}/gu },
  { name: 'bearer-token', expression: /Bearer\s+[A-Za-z0-9._-]{20,}/gu },
  { name: 'authorization-header', expression: /Authorization\s*:/giu },
  { name: 'literal-api-key', expression: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?(?!R37B_API_KEY)[A-Za-z0-9._-]{16,}/giu },
]

async function scan(root) {
  const findings = []
  for (const relativePath of await walkFiles(root)) {
    if (!/\.(json|log|md|txt|mjs|js|yml|yaml)$/u.test(relativePath)) continue
    const text = await readFile(join(root, relativePath), 'utf8')
    for (const pattern of SECRET_PATTERNS) {
      const matches = [...text.matchAll(pattern.expression)]
      if (matches.length > 0) {
        findings.push({
          path: `${root}/${relativePath}`,
          pattern: pattern.name,
          count: matches.length,
        })
      }
    }
  }
  return findings
}

const present = []
for (const source of SOURCES) {
  if (!await exists(source.path)) {
    present.push({ ...source, present: false })
    continue
  }
  present.push({
    ...source,
    present: true,
    files: (await walkFiles(source.path)).length,
    bytes: (await stat(source.path)).size,
  })
}
const missing = present.filter(source => !source.present)
if (missing.length > 0) {
  process.stderr.write(`missing evidence roots: ${missing.map(source => source.name).join(', ')}\n`)
  process.exit(1)
}

const findings = []
for (const source of SOURCES) findings.push(...await scan(source.path))
if (findings.length > 0) {
  await writeJson(OUT, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'refused-secret-shaped-content',
    findings,
  })
  process.stderr.write(`refusing archive: ${findings.length} credential-shaped finding(s)\n`)
  process.exit(1)
}

const staging = await mkdtemp(join(tmpdir(), 'r37c-evidence-'))
try {
  for (const source of SOURCES) {
    await cp(source.path, join(staging, source.name), { recursive: true })
  }
  for (const path of AUTHORITATIVE) {
    const destination = join(staging, 'authoritative', path.split('/').pop())
    await cp(join(ROOT, path), destination)
  }
  await writeJson(join(staging, 'ARCHIVE_META.json'), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R37-C',
    work: 'C0-A',
    sources: SOURCES.map(source => source.name),
    authoritative: AUTHORITATIVE,
    note: 'R37-B raw evidence and authoritative summaries. No credentials are included.',
  })
  await mkdir(ARCHIVE_DIR, { recursive: true })
  const tar = spawnSync('tar', ['-czf', `r37b-raw-evidence-${STAMP}.tar.gz`, '-C', staging, '.'], {
    cwd: ARCHIVE_DIR,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (tar.status !== 0) {
    throw new Error(`tar failed (${tar.status}): ${String(tar.stderr ?? '').slice(0, 500)}`)
  }
} finally {
  await rm(staging, { recursive: true, force: true })
}

const files = (await readdir(ARCHIVE_DIR)).filter(name => name.endsWith('.tar.gz')).sort()
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C0-A',
  status: 'archived',
  archive: {
    path: ARCHIVE_PATH,
    sha256: await sha256File(ARCHIVE_PATH),
    bytes: (await stat(ARCHIVE_PATH)).size,
    format: 'tar.gz',
  },
  sources: present,
  authoritative: AUTHORITATIVE,
  secretScan: { status: 'clean', findings: 0 },
  archiveDirectory: { path: ARCHIVE_DIR, archives: files },
  notes: [
    'The archive is outside the git worktree; it is not removed by git clean or worktree removal.',
    'A SHA-256 is recorded here and in evidence-inventory.json when R37C_ARCHIVE is supplied.',
    'Trace turn text remains capped at 1000 characters; the archive preserves the cap, not a full response.',
  ],
}
await writeJson(OUT, report)
process.stdout.write(`archive: ${ARCHIVE_PATH}\n`)
process.stdout.write(`sha256: ${report.archive.sha256}\n`)
process.stdout.write(`bytes: ${report.archive.bytes}\n`)
