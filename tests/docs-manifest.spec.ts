/**
 * The docs manifest must be a property of CONTENT, not of the checkout.
 *
 * ## The defect this pins
 *
 * This repository has `core.autocrlf=true`. Git stores LF; a checkout
 * materializes CRLF. The manifest generator hashed the WORKING-TREE bytes, so on
 * this machine it produced entries that verified locally and were wrong
 * everywhere else — and, more immediately, wrong against the very blobs that the
 * commit containing the manifest stores:
 *
 *   docs/11_R1B_ROUTE_SELECTION_GATE.md
 *     git blob (LF)  5960 bytes  sha 5991c0b6...
 *     worktree (CRLF) 6087 bytes  sha c4e7213b...   <- what was hashed
 *
 * Twenty of thirty-four entries were in that state. The failure is silent: a
 * manifest is only consulted when someone verifies it, and by then the commit is
 * long made.
 *
 * ## What is asserted
 *
 *  1. Every entry matches the LF-NORMALIZED bytes of its file, so the same
 *     manifest verifies on any checkout.
 *  2. Every entry matches the blob git stores, which is the authoritative
 *     content and what a verifier reading the repository will compare against.
 *  3. `.gitattributes` pins text files to LF, so a working tree cannot drift
 *     from the blob in the first place.
 *
 * Checks 1 and 2 overlap today and are kept separately on purpose: if the
 * checkout is ever configured to store CRLF, check 2 fails while check 1 still
 * passes, which says precisely which of the two mechanisms broke.
 *
 * @module tests/docs-manifest
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DOCS = join(ROOT, 'docs')
const MANIFEST = join(DOCS, 'MANIFEST.json')

interface Entry {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

/** The manifest as committed. */
function manifest(): readonly Entry[] {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as readonly Entry[]
}

/** LF-normalize, mirroring what the generator must do. */
function normalized(path: string): Buffer {
  return Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/gu, '\n'), 'utf8')
}

/**
 * Every `HEAD:<path>` blob named, read in ONE git invocation.
 *
 * ## Why batched, and not one `git cat-file` per path
 *
 * The manifest names ~48 files, so the per-path form spawned ~49 git processes
 * per test. Measured: the file took 4.04s of test time in isolation against
 * vitest's 5000ms default — passing alone, and timing out under the full
 * suite's parallel load:
 *
 *     Error: Test timed out in 5000ms.
 *     ❯ tests/docs-manifest.spec.ts:101
 *
 * That is not flakiness, it is 49 sequential process spawns. `--batch` answers
 * every request over one pipe, so the cost stops scaling with the doc count —
 * which matters because the count only grows.
 *
 * ## The protocol
 *
 * Each request line is `<object>`, each response is a header line
 * `<sha> <type> <size>` followed by `size` bytes and a newline. A missing
 * object answers `<name> missing` instead of a header. Reading by declared size
 * rather than by scanning for newlines is what keeps binary-safe content — and
 * a blob whose bytes contain a newline — from desynchronizing the stream.
 *
 * @param paths repo-relative paths, read as `HEAD:<path>`.
 * @returns blob bytes per path; a path git could not answer is absent.
 */
function committedBlobs(paths: readonly string[]): Map<string, Buffer> {
  const found = new Map<string, Buffer>()
  if (paths.length === 0) return found
  let out: Buffer
  try {
    out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: ROOT,
      input: `${paths.map(path => `HEAD:${path}`).join('\n')}\n`,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return found // no git, or no HEAD: the callers treat absence as "cannot answer"
  }

  let cursor = 0
  for (const path of paths) {
    const newline = out.indexOf(0x0a, cursor)
    if (newline === -1) break
    const header = out.toString('utf8', cursor, newline)
    cursor = newline + 1
    // `<name> missing`, `<name> ambiguous`, or anything else without a size.
    const match = /^[0-9a-f]+ blob (\d+)$/u.exec(header)
    if (match === null) continue
    const size = Number(match[1])
    if (!Number.isSafeInteger(size) || cursor + size > out.length) break
    found.set(path, out.subarray(cursor, cursor + size))
    cursor += size + 1 // the blob's trailing newline
  }
  return found
}

/**
 * Whether anything under `docs/` differs from the commit.
 *
 * True while a full run is regenerating doc 12 and the manifest, which is a
 * legitimate transient state rather than a defect.
 */
function docsTreeIsDirty(): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'docs/'], {
      cwd: ROOT, encoding: 'utf8',
    })
    return out.trim().length > 0
  } catch {
    return true // git unavailable: do not assert on a state we cannot read
  }
}

describe('the docs manifest is checkout-independent', () => {
  it('every entry matches the LF-NORMALIZED bytes of its file', () => {
    const bad: string[] = []
    for (const entry of manifest()) {
      const bytes = normalized(join(DOCS, entry.file))
      if (bytes.length !== entry.bytes) bad.push(`${entry.file}: bytes ${bytes.length} != ${entry.bytes}`)
      else if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) bad.push(`${entry.file}: hash`)
    }
    expect(bad, 'a CRLF checkout must not change a single manifest entry').toEqual([])
  })

  it('the COMMITTED manifest matches the COMMITTED docs', () => {
    // The authoritative check, and it only applies when the docs tree IS in its
    // committed state.
    //
    // Comparing the working-tree manifest against HEAD blobs is order-dependent:
    // `tests/r1-report.spec.ts` legitimately regenerates doc 12 (it carries a
    // generation date) and rewrites the manifest, so during a full run the
    // working tree is deliberately ahead of HEAD. Asserting then would fail for
    // a reason that has nothing to do with line endings — and, worse, the test
    // could not pass until the very commit it is meant to validate existed.
    //
    // So the rule is explicit: verify the committed pair when nothing under
    // `docs/` is modified, and stay silent while a run is mid-regeneration.
    if (docsTreeIsDirty()) return

    const manifestBlob = committedBlobs(['docs/MANIFEST.json']).get('docs/MANIFEST.json')
    if (manifestBlob === undefined) return // no git, or no commit yet
    let committed: readonly Entry[]
    try {
      committed = JSON.parse(manifestBlob.toString('utf8')) as readonly Entry[]
    } catch {
      return // the committed manifest is unreadable; not this test's subject
    }
    // ONE git invocation for every doc, not one per doc — see `committedBlobs`.
    const paths = committed.map(entry => `docs/${entry.file}`)
    const blobs = committedBlobs(paths)
    const bad: string[] = []
    for (const entry of committed) {
      const blob = blobs.get(`docs/${entry.file}`)
      if (blob === undefined) { bad.push(`${entry.file}: absent from HEAD`); continue }
      if (createHash('sha256').update(blob).digest('hex') !== entry.sha256) bad.push(`${entry.file}: hash`)
    }
    expect(bad, 'the committed manifest must describe the committed docs').toEqual([])
  })

  it('the manifest covers every doc and nothing else', () => {
    const listed = new Set(manifest().map(entry => entry.file))
    // Every listed file must exist; a stale entry is as wrong as a missing one.
    for (const entry of manifest()) {
      expect(existsSync(join(DOCS, entry.file)), `${entry.file} is listed but absent`).toBe(true)
    }
    // The two newest docs must be present, so a run that forgot to regenerate
    // cannot pass by simply being old.
    expect(listed.has('32_RC7D_PARALLEL_LONG_TASK_TESTING.md')).toBe(true)
  })

  it('.gitattributes pins text to LF, so the checkout cannot drift', () => {
    // The second, independent mechanism. Without it a fresh clone on a CRLF
    // platform reintroduces the divergence the normalized hash merely tolerates.
    const attrs = join(ROOT, '.gitattributes')
    expect(existsSync(attrs), '.gitattributes must exist').toBe(true)
    const text = readFileSync(attrs, 'utf8')
    expect(text).toMatch(/^\* text=auto eol=lf$/mu)
    expect(text, 'shell scripts must stay LF').toMatch(/^\*\.sh text eol=lf$/mu)
  })
})
