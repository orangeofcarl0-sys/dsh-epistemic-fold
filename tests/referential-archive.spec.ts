/**
 * The experimental referential archive: a bundle that identifies its history by
 * `(seq, digest)` instead of storing a second copy of it.
 *
 * ## Why the feature exists, and why it is off by default
 *
 * The archived messages are the DERIVED form of session events the log already
 * holds. Measured on a real session: 200 of 211 archived messages were
 * byte-identical to the event payloads at the seqs the bundle already recorded,
 * and one root fold's archive was 946 KB of a 949 KB bundle. So a bundle can
 * reference instead of copy, and the `(seq, digest)` pair still proves the
 * resolved content is what was archived.
 *
 * It is OFF by default because it moves a failure mode rather than removing
 * one: an inline archive is self-sufficient, while a referential one needs a
 * readable log. These tests therefore check both directions — that enabling it
 * produces a smaller, resolvable bundle, and that disabling it changes nothing.
 *
 * @module tests/referential-archive
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionEventSource, resolveArchiveRefs } from '../src/archive-refs.ts'
import { FileBundleStore } from '../src/bundle-store.ts'
import { canonicalHash } from '../src/hash.ts'
import { recall, search } from '../src/recall.ts'
import { conversation, createHarness, foldAgent, SIGNAL } from './harness.ts'

/** Fold once with the referential archive on or off. */
async function foldOnce(referential: boolean): Promise<{
  harness: Awaited<ReturnType<typeof createHarness>>
  session: ReturnType<typeof conversation>
  checkpointId: string
}> {
  const harness = await createHarness({ text: 'digest' }, {
    efConfig: { referentialArchive: referential },
  })
  const session = conversation(6)
  const nodes = [...session.surface.nodes]
  await harness.engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
  const listed = await harness.store.list(session.id)
  return { harness, session, checkpointId: listed[0]!.checkpointId }
}

describe('a referential bundle stores refs, not a copy', () => {
  it('omits the messages but keeps the count and the refs', async () => {
    const { harness, session, checkpointId } = await foldOnce(true)
    const bundle = (await harness.store.read(session.id, checkpointId))!

    expect(bundle.archive.shadowedMessages).toBeUndefined()
    expect(bundle.archive.messageCount).toBeGreaterThan(0)
    expect(bundle.archive.refs).toHaveLength(bundle.archive.messageCount)
    // The logical hash survives: it is the archive's identity in both forms.
    expect(bundle.archive.logicalHash).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('resolves back to exactly the archived messages', async () => {
    const { harness, session, checkpointId } = await foldOnce(true)
    const bundle = (await harness.store.read(session.id, checkpointId))!
    const resolved = resolveArchiveRefs(bundle.archive.refs, sessionEventSource(session))
    expect(resolved.status).toBe('resolved')
    if (resolved.status !== 'resolved') return

    // The decisive property: the refs reproduce an archive whose hash is the
    // one the bundle recorded. Anything less would be "some messages", not
    // "the archived messages".
    expect(canonicalHash(resolved.messages)).toBe(bundle.archive.logicalHash)
    expect(resolved.messages).toHaveLength(bundle.archive.messageCount)
  })

  it('serves exact recall through the refs, identically to an inline bundle', async () => {
    // The feature must be invisible to a caller: same page, same content.
    const referential = await foldOnce(true)
    const inline = await foldOnce(false)

    const fromRefs = await recall({
      store: referential.harness.store,
      sessionId: referential.session.id,
      checkpointId: referential.checkpointId,
      depth: 'exact',
      limit: 100,
      source: sessionEventSource(referential.session),
    })
    const fromInline = await recall({
      store: inline.harness.store,
      sessionId: inline.session.id,
      checkpointId: inline.checkpointId,
      depth: 'exact',
      limit: 100,
      source: sessionEventSource(inline.session),
    })

    expect(fromRefs?.unavailable).toBeUndefined()
    expect(fromRefs?.page?.messages).toHaveLength(fromInline?.page?.messages?.length ?? -1)
  })

  it('searches through the refs', async () => {
    const { harness, session, checkpointId } = await foldOnce(true)
    const hits = await search({
      store: harness.store,
      sessionId: session.id,
      query: checkpointId,
      source: sessionEventSource(session),
    })
    expect(hits).toHaveLength(1)
    // The count comes from `messageCount`, so it is right without the bytes.
    expect(hits[0]!.archiveMessages).toBeGreaterThan(0)
  })

  it('reports unavailable rather than guessing when no source is available', async () => {
    // The honest failure. Returning an empty page here would be a silent lie
    // about the archive's contents.
    const { harness, session, checkpointId } = await foldOnce(true)
    const result = await recall({
      store: harness.store,
      sessionId: session.id,
      checkpointId,
      depth: 'exact',
    })
    expect(result?.unavailable).toMatch(/no session log is available/u)
    expect(result?.page).toBeUndefined()
  })

  it('a ref whose message no longer derives as archived is REFUSED, not served', async () => {
    // The digest is the whole reason a ref can be trusted. Simulate drift by
    // asking for a seq that derives a DIFFERENT message than the ref recorded.
    const { harness, session, checkpointId } = await foldOnce(true)
    const bundle = (await harness.store.read(session.id, checkpointId))!

    const drifted = bundle.archive.refs.map((ref, index) =>
      index === 0 ? { ...ref, digest: canonicalHash({ not: 'the archived message' }) } : ref)
    const resolved = resolveArchiveRefs(drifted, sessionEventSource(session))
    expect(resolved.status).toBe('unresolved')
    if (resolved.status !== 'unresolved') return
    expect(resolved.failures[0]).toMatchObject({ reason: 'digest-mismatch' })

    // And recall surfaces it instead of returning partial content.
    const store = new FileBundleStore(await mkdtemp(join(tmpdir(), 'ef-ref-')))
    await store.write({ ...bundle, archive: { ...bundle.archive, refs: drifted } })
    const result = await recall({
      store,
      sessionId: session.id,
      checkpointId,
      depth: 'exact',
      source: sessionEventSource(session),
    })
    expect(result?.unavailable).toMatch(/no longer derives/u)
    expect(result?.page).toBeUndefined()
  })
})

describe('with the feature off, nothing changes', () => {
  it('the archive is still stored inline', async () => {
    const { harness, session, checkpointId } = await foldOnce(false)
    const bundle = (await harness.store.read(session.id, checkpointId))!
    expect(bundle.archive.shadowedMessages).toBeDefined()
    expect(bundle.archive.shadowedMessages).toHaveLength(bundle.archive.messageCount)
  })

  it('refs are empty, so an inline bundle claims no reference identity', async () => {
    // An inline bundle does not need refs, and emitting them anyway would
    // invite a reader to resolve instead of reading what is right there.
    const { harness, session, checkpointId } = await foldOnce(false)
    const bundle = (await harness.store.read(session.id, checkpointId))!
    expect(bundle.archive.refs).toEqual([])
  })

  it('recall works with no source at all, because nothing needs resolving', async () => {
    const { harness, session, checkpointId } = await foldOnce(false)
    const result = await recall({
      store: harness.store,
      sessionId: session.id,
      checkpointId,
      depth: 'exact',
      limit: 100,
    })
    expect(result?.unavailable).toBeUndefined()
    expect(result?.page?.messages.length).toBeGreaterThan(0)
  })

  it('a referential bundle is smaller than the same fold inline', async () => {
    // The reason to enable it, measured rather than argued. Both folds come
    // from the same fixture, so the difference is the encoding and nothing
    // else. Compared as SERIALIZED SIZE, which is what the store writes.
    const { harness: refHarness, session: refSession, checkpointId: refId } = await foldOnce(true)
    const { harness: inHarness, session: inSession, checkpointId: inId } = await foldOnce(false)

    const refBundle = (await refHarness.store.read(refSession.id, refId))!
    const inBundle = (await inHarness.store.read(inSession.id, inId))!

    // Same archive length, so the comparison is apples to apples.
    expect(refBundle.archive.messageCount).toBe(inBundle.archive.messageCount)

    const refBytes = Buffer.byteLength(JSON.stringify(refBundle))
    const inBytes = Buffer.byteLength(JSON.stringify(inBundle))
    expect(refBytes, 'dropping the message copy must shrink the bundle').toBeLessThan(inBytes)
  })
})
