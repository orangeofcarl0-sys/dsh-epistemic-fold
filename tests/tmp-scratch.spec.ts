/**
 * The scratch-space contract.
 *
 * Written after an audit found **44,035 directories** leaked into the system
 * temp directory by this project's own suites (35,533 `ef-m0-`, 8,311
 * `ef-eval-`). The content was small — about 290 MB — but the count is what
 * hurt: a temp directory with tens of thousands of entries makes every
 * enumeration of it slow, including those done by unrelated tools.
 *
 * On this machine the leak also landed on the wrong volume. `os.tmpdir()` is
 * `C:\Users\...\AppData\Local\Temp`; C: is the drive with the least free space
 * while the workspace drive has an order of magnitude more. Unreclaimed scratch
 * therefore accumulates on the volume that cannot afford it, which is exactly
 * the hazard this suite exists to prevent.
 *
 * These tests pin the four properties that make the leak impossible to
 * reintroduce silently:
 *
 *  1. scratch is created under ONE managed root, not scattered in `%TEMP%`;
 *  2. creation is REGISTERED, so a suite can reclaim its own;
 *  3. cleanup actually removes the directories;
 *  4. the sweep is prefix-bounded and age-bounded, so it cannot delete a live
 *     run's workspace or an unrelated tool's directory.
 *
 * @module tests/tmp-scratch
 */

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EF_TEMP_ROOT,
  OWNED_PREFIXES,
  cleanupTemps,
  isOwned,
  makeTemp,
  registeredTemps,
  releaseTemp,
  sweepStale,
} from '../eval/tmp.ts'

describe('scratch space is managed, not scattered', () => {
  it('creates every directory under the one managed root', async () => {
    const dir = await makeTemp('ef-m0-')
    try {
      // The parent is the managed root, so a sweep has a bounded subtree to
      // walk instead of scanning all of %TEMP%.
      expect(dir.startsWith(EF_TEMP_ROOT)).toBe(true)
      expect(dir).not.toBe(EF_TEMP_ROOT)
    } finally {
      await releaseTemp(dir)
    }
  })

  it('registers creations so a suite can reclaim its own', async () => {
    const before = registeredTemps().length
    const dir = await makeTemp('ef-m0-')
    expect(registeredTemps()).toContain(dir)
    await releaseTemp(dir)
    // Released directories leave the registry, so a later cleanup does not
    // chase a path that is already gone.
    expect(registeredTemps().length).toBe(before)
    expect(registeredTemps()).not.toContain(dir)
  })

  it('removes what it created, and tolerates an already-missing path', async () => {
    const dir = await makeTemp('ef-eval-')
    await writeFile(join(dir, 'bundle.json'), '{"x":1}')
    await cleanupTemps()
    await expect(readdir(dir)).rejects.toThrow()
    // Releasing twice is not an error: crash recovery may race a normal exit.
    await expect(releaseTemp(dir)).resolves.toBeUndefined()
  })

  it('leaves directories it does not own alone, and takes the ones it does', async () => {
    // An isolated parent standing in for %TEMP%, so this test does not depend
    // on the state of the machine's real temp directory.
    const parent = await mkdtemp(join(tmpdir(), 'sweep-probe-'))
    try {
      const foreign = join(parent, 'not-ours-abc123')
      const owned = join(parent, 'ef-m0-abc123')
      await mkdir(foreign, { recursive: true })
      await mkdir(owned, { recursive: true })
      const result = await sweepStale(0, [parent])
      const paths = result.removed.map(entry => entry.path)
      expect(paths).toContain(owned)
      expect(paths).not.toContain(foreign)
      await expect(readdir(foreign)).resolves.toEqual([])
      await expect(readdir(owned)).rejects.toThrow()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('never removes a directory younger than the age floor', async () => {
    const fresh = await makeTemp('ef-m0-')
    // A one-hour floor must protect a directory created moments ago: this is
    // what makes the sweep safe to run while another suite is mid-flight.
    const result = await sweepStale(60 * 60 * 1000, [EF_TEMP_ROOT])
    expect(result.removed.map(entry => entry.path)).not.toContain(fresh)
    await expect(readdir(fresh)).resolves.toEqual([])
    await releaseTemp(fresh)
  })

  it('sweeps an aged, owned directory and reports the bytes reclaimed', async () => {
    const aged = await makeTemp('ef-m0-')
    await writeFile(join(aged, 'payload.bin'), Buffer.alloc(4096, 7))
    // Age the directory past the floor rather than waiting an hour.
    const { utimes } = await import('node:fs/promises')
    const old = new Date(Date.now() - 7_200_000)
    await utimes(aged, old, old)
    const result = await sweepStale(60 * 60 * 1000, [EF_TEMP_ROOT])
    expect(result.removed.map(entry => entry.path)).toContain(aged)
    expect(result.bytes).toBeGreaterThanOrEqual(4096)
    await expect(readdir(aged)).rejects.toThrow()
  })

  it('treats every prefix the suites actually use as owned', async () => {
    // The sweep is only as good as this list: a prefix missing from it leaks
    // forever. These are the prefixes found in the working tree.
    for (const prefix of ['ef-m0-', 'ef-eval-', 'ef-task-', 'ef-flaky-', 'ef-plugin-', 'rc2-tools-', 'rc21-empty-']) {
      expect(isOwned(prefix), `${prefix} must be sweepable`).toBe(true)
    }
    expect(isOwned('not-ours-')).toBe(false)
    expect(OWNED_PREFIXES.length).toBeGreaterThan(0)
  })

  it('nests the managed root inside the system temp directory', async () => {
    // Kept under the OS temp directory so the OS still owns eventual cleanup,
    // while the name gives this project a bounded subtree.
    expect(EF_TEMP_ROOT.startsWith(tmpdir())).toBe(true)
    await mkdir(EF_TEMP_ROOT, { recursive: true })
    await expect(readdir(EF_TEMP_ROOT)).resolves.toBeInstanceOf(Array)
  })
})
