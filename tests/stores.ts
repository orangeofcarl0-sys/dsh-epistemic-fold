/**
 * Store test doubles for failure injection (T06, T21, T23).
 *
 * @module tests/stores
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBundleStore } from '../src/bundle-store.ts'
import type { FoldBundleStore } from '../src/types.ts'

/** A real store whose `write` always throws (archive-failure scenarios). */
export function failingStore(message = 'disk full'): FoldBundleStore {
  const real = new FileBundleStore('.')
  return {
    write: async () => {
      throw new Error(message)
    },
    read: real.read.bind(real),
    verify: real.verify.bind(real),
    list: real.list.bind(real),
    remove: real.remove.bind(real),
    recordCommit: real.recordCommit.bind(real),
    readCommitRecord: real.readCommitRecord.bind(real),
  }
}

/**
 * A store that fails the first `count` writes, then delegates to a real
 * store — the T23 recovery shape (crash mid-run, then heal).
 */
export async function flakyStore(firstFailing: number, message = 'disk full'): Promise<{ store: FoldBundleStore; real: FileBundleStore }> {
  const real = new FileBundleStore(await mkdtemp(join(tmpdir(), 'ef-flaky-')))
  let attempts = 0
  const store: FoldBundleStore = {
    write: async bundle => {
      attempts += 1
      if (attempts <= firstFailing) throw new Error(message)
      return real.write(bundle)
    },
    read: real.read.bind(real),
    verify: real.verify.bind(real),
    list: real.list.bind(real),
    remove: real.remove.bind(real),
    recordCommit: real.recordCommit.bind(real),
    readCommitRecord: real.readCommitRecord.bind(real),
  }
  return { store, real }
}
