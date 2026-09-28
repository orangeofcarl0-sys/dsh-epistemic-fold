/**
 * File-backed immutable bundle store: same-directory temp file, atomic rename
 * (via DSH's own `writeFileAtomic`), restricted permissions, and read-back
 * hash verification before a write reports success.
 *
 * @module dsh-epistemic-fold/bundle-store
 */

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash, canonicalJson, sha256Hex } from './hash.ts'
import type {
  BundleDescriptor,
  BundleVerification,
  BundleWriteResult,
  CheckpointBundleV1,
  FoldBundleStore,
} from './types.ts'

/** File permission bits for bundle files and their per-session directories. */
const BUNDLE_FILE_MODE = 0o600
const BUNDLE_DIR_MODE = 0o700

function bundlePath(root: string, sessionId: string, checkpointId: string): string {
  return join(root, sessionId, `bundle-${checkpointId}.json`)
}

/**
 * One directory of bundle files, one subdirectory per session. Writes are
 * atomic and verified; readers detect corruption through the stored logical
 * hash instead of trusting file contents.
 */
export class FileBundleStore implements FoldBundleStore {
  constructor(private readonly root: string) {}

  async write(bundle: CheckpointBundleV1): Promise<BundleWriteResult> {
    const serialized = canonicalJson(bundle)
    const fileHash = sha256Hex(serialized)
    const target = bundlePath(this.root, bundle.sessionId, bundle.checkpointId)
    await mkdir(dirname(target), { recursive: true, mode: BUNDLE_DIR_MODE })
    await writeFileAtomic(target, serialized, { mode: BUNDLE_FILE_MODE, dirMode: BUNDLE_DIR_MODE })
    // Read back and verify before claiming durability (C0.4 fail-closed path).
    const stored = await readFile(target, 'utf8')
    if (sha256Hex(stored) !== fileHash) {
      throw new Error(`epistemic-fold: bundle write verification failed for ${bundle.checkpointId}`)
    }
    const parsed = JSON.parse(stored) as CheckpointBundleV1
    if (parsed.archive.logicalHash !== bundle.archive.logicalHash) {
      throw new Error(`epistemic-fold: bundle read-back logical hash mismatch for ${bundle.checkpointId}`)
    }
    return {
      checkpointId: bundle.checkpointId,
      fileHash,
      bytes: Buffer.byteLength(stored, 'utf8'),
    }
  }

  async read(checkpointId: string): Promise<CheckpointBundleV1 | null> {
    const descriptor = await this.locate(checkpointId)
    if (descriptor === undefined) return null
    return this.readBundle(descriptor.file)
  }

  async verify(checkpointId: string): Promise<BundleVerification> {
    const descriptor = await this.locate(checkpointId)
    if (descriptor === undefined) return { status: 'missing' }
    const bundle = await this.readBundle(descriptor.file)
    if (bundle === null) return { status: 'missing' }
    if (bundle.checkpointId !== checkpointId) {
      return { status: 'corrupt', reason: 'stored checkpointId does not match the requested id' }
    }
    const logical = canonicalHash(bundle.archive.shadowedMessages)
    if (logical !== bundle.archive.logicalHash) {
      return { status: 'corrupt', reason: 'archive logical hash mismatch' }
    }
    const rendered = canonicalHash(bundle.rendered.text)
    if (rendered !== bundle.rendered.digest) {
      return { status: 'corrupt', reason: 'rendered digest mismatch' }
    }
    return { status: 'verified', bundle }
  }

  async list(sessionId: SessionId): Promise<BundleDescriptor[]> {
    const dir = join(this.root, sessionId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const descriptors: BundleDescriptor[] = []
    for (const name of names) {
      if (!name.startsWith('bundle-') || !name.endsWith('.json')) continue
      const file = join(dir, name)
      const bundle = await this.readBundle(file)
      if (bundle === null) continue
      descriptors.push(await this.describe(bundle))
    }
    return descriptors.sort((left, right) => left.createdAt - right.createdAt)
  }

  async remove(checkpointId: string): Promise<void> {
    const descriptor = await this.locate(checkpointId)
    if (descriptor === undefined) return
    await rm(descriptor.file, { force: true })
  }

  private async locate(checkpointId: string): Promise<{ file: string; sessionId: string } | undefined> {
    let sessions: string[]
    try {
      sessions = await readdir(this.root)
    } catch {
      return undefined
    }
    for (const sessionId of sessions) {
      const file = bundlePath(this.root, sessionId, checkpointId)
      try {
        await stat(file)
        return { file, sessionId }
      } catch {
        // Keep scanning the remaining session directories.
      }
    }
    return undefined
  }

  /** Read one bundle file; unreadable or unparseable files read as absent. */
  private async readBundle(file: string): Promise<CheckpointBundleV1 | null> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return null
    }
    try {
      return JSON.parse(raw) as CheckpointBundleV1
    } catch {
      return null
    }
  }

  private async describe(bundle: CheckpointBundleV1): Promise<BundleDescriptor> {
    const descriptor = await this.locate(bundle.checkpointId)
    const bytes = descriptor === undefined ? 0 : (await stat(descriptor.file)).size
    return {
      checkpointId: bundle.checkpointId,
      sessionId: bundle.sessionId,
      mode: bundle.mode,
      createdAt: bundle.createdAt,
      bytes,
    }
  }
}
