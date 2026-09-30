/**
 * Managed scratch space for the eval suites.
 *
 * ## Why this exists
 *
 * Every suite in this repository created its scratch directory with a bare
 * `mkdtemp(join(tmpdir(), 'ef-...'))` and never removed it. Across the RC7
 * parallel batches that leaked **44,035 directories** into the system temp
 * directory — about 290 MB of content, but the count is the real damage: a
 * Windows temp directory that large makes every directory enumeration (and so
 * every unrelated tool that scans `%TEMP%`) pathologically slow.
 *
 * On this machine the leak also landed on the wrong drive. `os.tmpdir()` is
 * `C:\Users\...\AppData\Local\Temp`, and C: is the drive with the least free
 * space (16 GB of 201 GB at the time of writing), while the workspace drive has
 * 146 GB. Scratch that is never reclaimed therefore accumulates on the one
 * volume that cannot afford it.
 *
 * ## The three guarantees
 *
 *  1. **One root.** Every directory is created under `EF_TEMP_ROOT`, so a sweep
 *     never has to guess which of `%TEMP%`'s thousands of entries are ours.
 *  2. **Registered.** Each creation is recorded, so a suite can reclaim its own
 *     scratch deterministically instead of relying on process exit.
 *  3. **Sweepable.** `sweepStale` removes leftovers from a crashed run, with an
 *     age floor so it can never delete a directory a live run is still using.
 *
 * Nothing here deletes outside the prefixes this project owns. That is the
 * property that makes it safe to run `sweepStale` at any time.
 *
 * @module eval/tmp
 */

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The single directory every suite creates scratch under.
 *
 * Kept as a child of the system temp directory rather than a bespoke location
 * so the OS still owns eventual cleanup, while the name gives us a bounded
 * subtree to sweep.
 */
export const EF_TEMP_ROOT = join(tmpdir(), 'ef-tmp')

/**
 * Directory-name prefixes this project creates.
 *
 * `ef-` covers the eval and unit suites; `rc2-`/`rc21-` cover the real-task
 * suites. The list is used by the sweep, so a prefix missing here would leak
 * forever — which is why the sweep is tested against it.
 */
export const OWNED_PREFIXES: readonly string[] = ['ef-', 'rc2-', 'rc21-', 'ef-tmp']

/** Directories created in this process, so a suite can reclaim its own. */
const registry = new Set<string>()

/** Create a scratch directory under the managed root and register it. */
export async function makeTemp(prefix: string): Promise<string> {
  await mkdir(EF_TEMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(EF_TEMP_ROOT, prefix))
  registry.add(dir)
  return dir
}

/** Every scratch directory this process has created and not yet released. */
export function registeredTemps(): readonly string[] {
  return [...registry]
}

/** Release one scratch directory. Missing directories are not an error. */
export async function releaseTemp(dir: string): Promise<void> {
  registry.delete(dir)
  await rm(dir, { recursive: true, force: true })
}

/**
 * Remove every directory this process created.
 *
 * Returns the count removed so a suite can assert it reclaimed what it made.
 */
export async function cleanupTemps(): Promise<number> {
  const dirs = [...registry]
  registry.clear()
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  return dirs.length
}

/** One swept directory, so a caller can report what was reclaimed. */
export interface SweepEntry {
  readonly path: string
  readonly bytes: number
}

/** The result of a sweep. */
export interface SweepResult {
  readonly removed: readonly SweepEntry[]
  readonly bytes: number
}

/** Total bytes under a directory, bounded so a huge tree cannot hang a sweep. */
async function measure(path: string, budget = 5_000): Promise<number> {
  let total = 0
  let seen = 0
  const walk = async (dir: string): Promise<void> => {
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
          // A file that vanished mid-walk contributes nothing.
        }
      }
    }
  }
  await walk(path)
  return total
}

/**
 * Is this directory one of ours?
 *
 * Matched on the basename's prefix, so the sweep can look inside the managed
 * root AND at legacy directories left directly in the system temp directory by
 * the pre-`EF_TEMP_ROOT` suites.
 */
export function isOwned(name: string): boolean {
  return OWNED_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * Remove stale scratch directories.
 *
 * Two locations are swept, because the leak predates the managed root:
 *
 *  - `EF_TEMP_ROOT` itself, whose children are all ours by construction;
 *  - the system temp directory, where only entries matching `OWNED_PREFIXES`
 *    are considered.
 *
 * The age floor is what makes this safe to call from a running test: a
 * directory younger than `maxAgeMs` is left alone, so a concurrent suite cannot
 * have its workspace deleted underneath it.
 *
 * Sweeping the system temp directory is inherently slow while the historical
 * leak is still present: the age check needs a `stat` per candidate, and 44,035
 * of them were measured at ~5 s. That cost is the symptom, not the design — it
 * falls to milliseconds once the backlog is gone.
 *
 * @param maxAgeMs - only remove directories older than this.
 * @param roots - override the locations swept; tests scope this to avoid
 *   depending on the state of the machine's temp directory.
 * @returns what was removed, with the bytes reclaimed.
 */
export async function sweepStale(
  maxAgeMs = 60 * 60 * 1000,
  roots: readonly string[] = [EF_TEMP_ROOT, tmpdir()],
): Promise<SweepResult> {
  const now = Date.now()
  const removed: SweepEntry[] = []

  const sweep = async (parent: string, filter: (name: string) => boolean): Promise<void> => {
    let entries
    try {
      entries = await readdir(parent, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !filter(entry.name)) continue
      const path = join(parent, entry.name)
      try {
        const info = await stat(path)
        // A floor of 0 means "no floor". Stated as an explicit branch rather
        // than a bare `< maxAgeMs`, because a filesystem timestamp can be a
        // fraction newer than the `now` captured above; that makes the age
        // negative, and a negative age is not "younger than zero" in any sense
        // a caller means.
        if (maxAgeMs > 0 && now - info.mtimeMs < maxAgeMs) continue
        const bytes = await measure(path)
        await rm(path, { recursive: true, force: true })
        registry.delete(path)
        removed.push({ path, bytes })
      } catch {
        // Racing another sweep, or a permission problem: leave it for next time.
      }
    }
  }

  for (const root of roots) {
    // The managed root's children are ours by construction, so no prefix
    // filter; anywhere else, only owned names are considered.
    if (root === EF_TEMP_ROOT) await sweep(root, () => true)
    else await sweep(root, isOwned)
  }

  return { removed, bytes: removed.reduce((sum, entry) => sum + entry.bytes, 0) }
}
