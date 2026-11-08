#!/usr/bin/env node
/**
 * Generate `docs/MANIFEST.json` — the LF-normalized content index of every
 * Markdown document under `docs/`.
 *
 * ## Why this is its own command (EF-C1)
 *
 * The manifest used to be regenerated inside `tests/r1-report.spec.ts`, as a
 * side effect of the R1 report generator. That coupled two unrelated artifacts
 * and made an ordinary test write a tracked file. Worse, it hid a real failure:
 * `tests/docs-manifest.spec.ts` skips its authoritative check while the docs
 * tree is dirty, so the test that rewrote `docs/` made the test that verifies
 * `docs/` stay silent.
 *
 * The manifest is a generated configuration file, not evidence. It may be
 * regenerated deliberately; it must never be rewritten by a test run.
 *
 * ## Usage
 *
 *   node scripts/generate-docs-manifest.mjs            compare only (default)
 *   node scripts/generate-docs-manifest.mjs --check     same, strict exit 2
 *   node scripts/generate-docs-manifest.mjs --output <path>
 *   node scripts/generate-docs-manifest.mjs --write
 *
 * ## Why the bytes are normalized before hashing
 *
 * This repository has `core.autocrlf=true` and `.gitattributes` pins text to
 * LF, but a checkout can still materialize CRLF. Hashing the working-tree bytes
 * produced a manifest that verified on the machine that generated it and
 * mismatched against the very blobs `git show` returns. Normalizing to LF makes
 * the hash a property of the CONTENT rather than of the checkout.
 *
 * @module scripts/generate-docs-manifest
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const MANIFEST = join(DOCS, 'MANIFEST.json')

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const write = process.argv.includes('--write')
const output = arg('output')

if (write && output !== undefined) {
  console.error('generate-docs-manifest: --write and --output are mutually exclusive')
  process.exit(1)
}

/** Every `docs/*.md`, sorted, hashed over LF-normalized bytes. */
function buildManifest() {
  return readdirSync(DOCS)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const bytes = readFileSync(join(DOCS, name))
      const normalized = Buffer.from(bytes.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')
      return {
        file: name,
        bytes: normalized.length,
        sha256: createHash('sha256').update(normalized).digest('hex'),
      }
    })
}

const manifest = buildManifest()
const text = `${JSON.stringify(manifest, null, 2)}\n`

if (output !== undefined) {
  writeFileSync(output, text, 'utf8')
  console.log(`wrote candidate ${output} (${manifest.length} files, hashed LF-normalized)`)
  process.exit(0)
}

if (write) {
  writeFileSync(MANIFEST, text, 'utf8')
  console.log(`wrote docs/MANIFEST.json (${manifest.length} files, hashed LF-normalized)`)
  process.exit(0)
}

// Default and --check: compare, never write.
const current = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : ''
if (current.replace(/\r\n/gu, '\n') === text) {
  console.log(`docs/MANIFEST.json is current (${manifest.length} files)`)
  process.exit(0)
}
console.error(
  `docs/MANIFEST.json is OUT OF DATE (${manifest.length} docs on disk). `
  + 'Run with --write to promote, or --output <path> to inspect the candidate first.',
)
process.exit(2)
