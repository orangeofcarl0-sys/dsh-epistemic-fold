/**
 * The bundle file encoding: compressed envelope, tolerant reads, and the
 * exact-recall guarantee that must survive the change.
 *
 * ## What this suite is protecting
 *
 * `FileBundleStore` used to write `canonicalJson(bundle)` verbatim. A bundle
 * holds the exact model-visible messages a fold removed, so that made EF's copy
 * of a session cost several times the session log's own on-disk size (measured:
 * 949 KB of bundle against a 1.78 MB compressed log holding the same content).
 * Bundles are now zstd envelopes.
 *
 * The saving is only acceptable because it is LOSSLESS. So the tests here are
 * not "does it compress" — they are "does everything that depended on the old
 * bytes still hold": the archive's logical identity, exact recall, corruption
 * detection, and the tolerance for bundles already on disk in the old format.
 *
 * @module tests/bundle-codec
 */

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  BUNDLE_FILE_FORMAT,
  decodeBundleFile,
  encodeBundleFile,
  isBundleEnvelope,
} from '../src/bundle-codec.ts'
import { FileBundleStore } from '../src/bundle-store.ts'
import { canonicalHash, canonicalJson } from '../src/hash.ts'
import type { CheckpointBundleV1 } from '../src/types.ts'

const SESSION = SessionId('session-codec')

/** A bundle whose archive is large enough to be worth compressing. */
function bundleOf(options: {
  checkpointId: string
  messageCount: number
  textLength?: number
}): CheckpointBundleV1 {
  const textLength = options.textLength ?? 400
  const messages: Message[] = Array.from({ length: options.messageCount }, (_, index) =>
    createUserMessage({
      content: [{ type: 'text', text: `message ${index} ${'payload '.repeat(Math.ceil(textLength / 8))}` }],
      source: { kind: 'user' },
    }))
  return {
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId: options.checkpointId,
    sessionId: SESSION,
    createdAt: 1_700_000_000_000,
    mode: 'leaf',
    source: {
      orderedSurfaceSeqs: [1, 2, 3] as never,
      sourceDigest: canonicalHash({ seed: options.checkpointId }),
    },
    archive: {
      shadowedMessages: messages,
      logicalHash: canonicalHash(messages),
    },
    rendered: {
      text: 'checkpoint body',
      digest: canonicalHash('checkpoint body'),
    },
  }
}

/** A fresh store root under the OS temp directory. */
async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ef-codec-'))
}

describe('the bundle file is a compressed envelope', () => {
  it('round-trips a bundle byte-for-byte at the message level', () => {
    const bundle = bundleOf({ checkpointId: 'cp-roundtrip', messageCount: 40 })
    const decoded = decodeBundleFile(encodeBundleFile(bundle))
    // The archive is the part that must survive exactly: it is the exact
    // history recall returns, and `logicalHash` is its identity.
    expect(decoded.archive.logicalHash).toBe(bundle.archive.logicalHash)
    expect(canonicalJson(decoded)).toBe(canonicalJson(bundle))
  })

  it('actually saves space on an archive-shaped bundle', () => {
    // Guards the reason for the change: if the encoder ever silently stopped
    // compressing, every other test here would still pass.
    const bundle = bundleOf({ checkpointId: 'cp-ratio', messageCount: 60 })
    const encoded = encodeBundleFile(bundle)
    const plain = canonicalJson(bundle)
    expect(encoded.length).toBeLessThan(plain.length / 2)
  })

  it('is deterministic, so the write path can verify what it wrote', () => {
    // The store hashes the file it just wrote and compares. That only works if
    // the same bundle always encodes to the same bytes.
    const bundle = bundleOf({ checkpointId: 'cp-det', messageCount: 20 })
    expect(encodeBundleFile(bundle)).toBe(encodeBundleFile(bundle))
  })

  it('carries a format marker, so a bare bundle is distinguishable', () => {
    const envelope = JSON.parse(encodeBundleFile(bundleOf({ checkpointId: 'cp-mark', messageCount: 5 }))) as unknown
    expect(isBundleEnvelope(envelope)).toBe(true)
    expect((envelope as { format: string }).format).toBe(BUNDLE_FILE_FORMAT)
    // A bare bundle is NOT an envelope: the two share no marker.
    expect(isBundleEnvelope(bundleOf({ checkpointId: 'cp-bare', messageCount: 5 }))).toBe(false)
  })
})

describe('bundles written before compression still read', () => {
  it('decodes a plain uncompressed bundle', () => {
    // Real installs have these on disk. Refusing them would turn an encoding
    // improvement into silent recall loss for every session that already folded.
    const bundle = bundleOf({ checkpointId: 'cp-legacy', messageCount: 12 })
    const decoded = decodeBundleFile(canonicalJson(bundle))
    expect(decoded.archive.logicalHash).toBe(bundle.archive.logicalHash)
  })

  it('a store reads a legacy file it did not write', async () => {
    const root = await freshRoot()
    const store = new FileBundleStore(root)
    const bundle = bundleOf({ checkpointId: 'cp-legacy-store', messageCount: 12 })

    // Write the OLD format by hand, exactly as the previous implementation did.
    const dir = join(root, String(SESSION))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'bundle-cp-legacy-store.json'), canonicalJson(bundle))

    const verification = await store.verify(SESSION, 'cp-legacy-store')
    expect(verification.status).toBe('verified')
    const read = await store.read(SESSION, 'cp-legacy-store')
    expect(read?.archive.logicalHash).toBe(bundle.archive.logicalHash)
  })
})

describe('the store writes compressed files and keeps its guarantees', () => {
  it('writes an envelope, and verify accepts it', async () => {
    const root = await freshRoot()
    const store = new FileBundleStore(root)
    const bundle = bundleOf({ checkpointId: 'cp-write', messageCount: 50 })
    const result = await store.write(bundle)

    const onDisk = await readFile(join(root, String(SESSION), 'bundle-cp-write.json'), 'utf8')
    expect(isBundleEnvelope(JSON.parse(onDisk) as unknown)).toBe(true)
    expect(result.bytes).toBe(Buffer.byteLength(onDisk, 'utf8'))

    const verification = await store.verify(SESSION, 'cp-write')
    expect(verification.status).toBe('verified')
    expect(verification.status === 'verified' && verification.bundle.archive.logicalHash)
      .toBe(bundle.archive.logicalHash)
  })

  it('list() sees compressed bundles', async () => {
    const store = new FileBundleStore(await freshRoot())
    await store.write(bundleOf({ checkpointId: 'cp-list', messageCount: 30 }))
    const listed = await store.list(SESSION)
    expect(listed.map(entry => entry.checkpointId)).toEqual(['cp-list'])
  })

  it('reports a truncated payload as CORRUPT, not as absent', async () => {
    // Corruption and absence mean different things in an audit (R0-A), and the
    // new failure mode — an undecodable frame — must land on the corrupt side.
    const root = await freshRoot()
    const store = new FileBundleStore(root)
    await store.write(bundleOf({ checkpointId: 'cp-trunc', messageCount: 30 }))

    const file = join(root, String(SESSION), 'bundle-cp-trunc.json')
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: string }
    envelope.payload = envelope.payload.slice(0, Math.floor(envelope.payload.length / 2))
    await writeFile(file, canonicalJson(envelope))

    const verification = await store.verify(SESSION, 'cp-trunc')
    expect(verification.status).toBe('corrupt')
  })

  it('a compressed bundle tampered at the message level still fails the logical hash', async () => {
    // The hash that protects the archive must not be bypassed by re-encoding:
    // an attacker who rewrites the payload and re-compresses must still be
    // caught, because the hash covers the messages rather than the file.
    const root = await freshRoot()
    const store = new FileBundleStore(root)
    const bundle = bundleOf({ checkpointId: 'cp-tamper', messageCount: 10 })
    await store.write(bundle)

    const tampered: CheckpointBundleV1 = {
      ...bundle,
      archive: {
        ...bundle.archive,
        shadowedMessages: [createUserMessage({
          content: [{ type: 'text', text: 'rewritten' }],
          source: { kind: 'user' },
        })],
      },
    }
    // Re-encode with the honest encoder, so only the LOGICAL hash can catch it.
    await writeFile(join(root, String(SESSION), 'bundle-cp-tamper.json'), encodeBundleFile(tampered))

    const verification = await store.verify(SESSION, 'cp-tamper')
    expect(verification.status).toBe('corrupt')
    expect(verification.status === 'corrupt' && verification.reason).toMatch(/logical hash/u)
  })
})
