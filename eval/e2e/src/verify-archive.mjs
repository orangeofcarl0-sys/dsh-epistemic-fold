#!/usr/bin/env node
/**
 * Verify an EXTERNAL research archive against the repository's pointer.
 *
 * The archive is not in git; the repository carries only hashes. A reader who
 * receives a copy can run this to answer three questions without trusting the
 * copy's own manifest:
 *
 *   1. do all files match SHA256SUMS?
 *   2. does the manifest match the pointer's hash?
 *   3. is the git bundle present, and does its hash match?
 *
 * It never writes to the archive. It reports, it does not repair.
 *
 *   node eval/e2e/src/verify-archive.mjs --archive ../EF_E2E_RESEARCH_ARCHIVE
 *
 * @module eval/e2e/src/verify-archive
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const argv = process.argv.slice(2)
const value = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const ARCHIVE = resolve(value('archive') ?? join(ROOT, '..', 'EF_E2E_RESEARCH_ARCHIVE'))
const POINTER = resolve(value('pointer') ?? join(ROOT, 'eval', 'e2e', 'out', 'research-archive.json'))
const OUT = value('out') === undefined ? undefined : resolve(value('out'))

const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const problems = []

if (!existsSync(ARCHIVE)) {
  process.stderr.write(`verify-archive: ${ARCHIVE} does not exist\n`)
  process.exit(2)
}
if (!existsSync(POINTER)) {
  process.stderr.write(`verify-archive: pointer ${POINTER} does not exist\n`)
  process.exit(2)
}
const pointer = JSON.parse(readFileSync(POINTER, 'utf8'))

// 1. Every file in SHA256SUMS.
const sumsPath = join(ARCHIVE, 'SHA256SUMS')
if (!existsSync(sumsPath)) problems.push('SHA256SUMS is missing')
let listed = 0
let matched = 0
if (existsSync(sumsPath)) {
  for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line)
    if (match === null) {
      problems.push(`malformed SHA256SUMS line: ${line.slice(0, 80)}`)
      continue
    }
    listed += 1
    const file = join(ARCHIVE, match[2])
    if (!existsSync(file)) {
      problems.push(`missing: ${match[2]}`)
      continue
    }
    if (sha256File(file) === match[1]) matched += 1
    else problems.push(`hash mismatch: ${match[2]}`)
  }
}

// 2. Manifest and sums against the pointer.
const manifestPath = join(ARCHIVE, 'manifest.json')
if (!existsSync(manifestPath)) problems.push('manifest.json is missing')
else if (sha256File(manifestPath) !== pointer.archiveManifestSha256) {
  problems.push('manifest.json does not match the pointer')
}
if (existsSync(sumsPath) && sha256File(sumsPath) !== pointer.archiveSumsSha256) {
  problems.push('SHA256SUMS does not match the pointer')
}

// 3. Bundle presence and hash.
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
const bundlePath = manifest?.bundle?.path === undefined ? undefined : join(ARCHIVE, manifest.bundle.path)
if (bundlePath === undefined || !existsSync(bundlePath)) {
  problems.push('git bundle is missing')
} else if (manifest.bundle.sha256 !== undefined && sha256File(bundlePath) !== manifest.bundle.sha256) {
  problems.push('git bundle does not match the manifest')
}

const report = {
  schemaVersion: 1,
  work: pointer.work ?? 'research-archive',
  generatedAt: new Date().toISOString(),
  archive: ARCHIVE.replace(/\\/gu, '/'),
  pointer: POINTER.replace(/\\/gu, '/'),
  listed,
  matched,
  manifestSha256: existsSync(manifestPath) ? sha256File(manifestPath) : null,
  bundleSha256: bundlePath !== undefined && existsSync(bundlePath) ? sha256File(bundlePath) : null,
  scan: manifest?.scan ?? null,
  problems,
  verdict: problems.length === 0 && listed === matched && pointer.scan?.safeToShare === true
    ? 'archive-verified'
    : 'archive-problem',
}
if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.verdict !== 'archive-verified') process.exit(1)
