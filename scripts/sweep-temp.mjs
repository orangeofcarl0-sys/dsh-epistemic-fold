/**
 * Reclaim scratch directories left by the eval suites.
 *
 * Run this when `%TEMP%` has grown large, or after a suite crashed mid-run.
 * It only ever removes directories whose names match the prefixes this project
 * owns, and it never touches anything younger than the age floor — so it is
 * safe to run while a test is in flight.
 *
 * Usage:
 *   node scripts/sweep-temp.mjs              # older than 1 hour
 *   node scripts/sweep-temp.mjs 0            # everything, regardless of age
 *   node scripts/sweep-temp.mjs 3600000 --dry # report only
 *
 * @module scripts/sweep-temp
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const maxAgeMs = Number(args.find(arg => !arg.startsWith('--')) ?? 3_600_000)

/** Prefixes this project creates. Anything else in TEMP is left alone. */
const OWNED = ['ef-tmp', 'ef-m0-', 'ef-eval-', 'ef-task-', 'ef-flaky-', 'ef-plugin-', 'rc2-', 'rc21-']

const isOwned = name => OWNED.some(prefix => name.startsWith(prefix))

/**
 * Bytes under a directory.
 *
 * A directory's own `stat().size` is 0 on Windows and the block size on POSIX,
 * so neither reports what a tree holds. Walking it is the only honest number —
 * and it is why the sweep reports bytes separately from the removal count.
 */
const measure = async (path, budget = 20_000) => {
  let total = 0
  let seen = 0
  const walk = async dir => {
    if (seen > budget) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (seen > budget) return
      seen += 1
      const child = join(dir, entry.name)
      if (entry.isDirectory()) await walk(child)
      else {
        try {
          total += (await stat(child)).size
        } catch {
          // Vanished mid-walk.
        }
      }
    }
  }
  await walk(path)
  return total
}

const roots = [join(tmpdir(), 'ef-tmp'), tmpdir()]
const now = Date.now()
let removed = 0
let bytes = 0
let skippedYoung = 0

for (const [index, root] of roots.entries()) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // The managed root's children are all ours; elsewhere require a prefix.
    const managed = index === 0
    if (!managed && !isOwned(entry.name)) continue
    const path = join(root, entry.name)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (maxAgeMs > 0 && now - info.mtimeMs < maxAgeMs) {
      skippedYoung += 1
      continue
    }
    const size = await measure(path)
    if (!dryRun) await rm(path, { recursive: true, force: true })
    removed += 1
    bytes += size
  }
}

const action = dryRun ? 'would remove' : 'removed'
console.log(
  `sweep-temp: ${action} ${removed} director${removed === 1 ? 'y' : 'ies'} `
  + `(${(bytes / 1e6).toFixed(1)} MB), kept ${skippedYoung} younger than ${maxAgeMs} ms`,
)
if (dryRun) console.log('sweep-temp: dry run — nothing was deleted')
