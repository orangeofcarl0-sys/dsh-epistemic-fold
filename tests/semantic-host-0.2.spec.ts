/**
 * The REAL 0.2.1 host: plugin records are the durable transport.
 *
 * The rest of the suite runs against the vendored 0.1.7 line, which has no
 * `appendPluginRecord`. This file deliberately bypasses the Vitest vendor alias
 * (`createRequire` resolves the installed 0.2.1 package) so the claims about
 * the real host are MEASURED here rather than inferred from a version number.
 *
 * What is proved:
 *
 *   - `appendPluginRecord` writes the `ignorable` marker, and the host's own
 *     persistence validator retains the record.
 *   - `Session.append` still drops an options-bag marker on this build, which
 *     is why the old probe correctly refused every raw `ef/anchor` write.
 *   - EF's transport, reader, record guard, and projection consume the host's
 *     record without a second state model.
 *
 * NOT proved here: a full process restart through the JSONL backend. That
 * backend needs the host's own cordis services, which cannot be mixed with the
 * vendored test runtime; `docs/semantic-continuity/HOST_COMPATIBILITY.md` states
 * the limitation and the exact command to close it.
 *
 * @module tests/semantic-host-0.2
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { Session as VendorSession } from '@deepseek-ai/dsh-session'
import {
  appendPluginEvent,
  efPluginRecordOf,
  pluginEventTransport,
} from '../src/state/plugin-events.ts'
import type { PluginEventApi } from '../src/state/plugin-events.ts'
import { semanticRecordOf, semanticRecordsIn } from '../src/semantic/record.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import { projectSemanticRecords } from '../src/semantic/record.ts'
import { SEMANTIC_SCHEMA_VERSION } from '../src/semantic/types.ts'

const requireHost = createRequire(import.meta.url)

/** The host session package, typed only as far as this test uses it. */
interface HostSession {
  readonly seq: number
  append(type: string, data: unknown, opts?: unknown): { readonly ignorable?: unknown }
  snapshotEvents(): readonly unknown[]
}

interface HostApi extends PluginEventApi {
  readonly Session: { create(id: unknown): HostSession }
  readonly SessionId: (value: string) => unknown
  readonly appendPluginRecord: (session: HostSession, type: string, data: unknown) => number
  readonly pluginRecordOf: (event: unknown) => {
    readonly type: string
    readonly seq: number
    readonly time: number
    readonly data: unknown
  } | undefined
  readonly SESSION_FORMAT_VERSION: number
}

const host = requireHost('@deepseek-ai/dsh-session') as HostApi
const hostPersistence = requireHost('@deepseek-ai/dsh-session-persistence') as {
  validateStoredEvents: (header: unknown, events: readonly unknown[]) => readonly unknown[]
}

const headerOf = (id: string) => ({
  version: host.SESSION_FORMAT_VERSION,
  id: host.SessionId(id),
  createdAt: 1000,
  isSeeded: false,
  cwd: '/work',
})

const payload = {
  schemaVersion: SEMANTIC_SCHEMA_VERSION,
  packetId: 'packet-1',
  checkpointId: 'cp-1',
  foldedSeqs: [1, 2, 3],
  bodyDigest: 'digest-1',
  ops: [{
    op: 'declare' as const,
    anchor: {
      id: 'semantic-aaaa',
      kind: 'constraint' as const,
      stateKey: { namespace: 'semantic', entity: 'constraint', property: 'timeout' },
      value: 'The timeout is 30 seconds.',
      authority: 'normative' as const,
      lifecycle: 'active' as const,
      sourceRefs: [{ seq: 1 }],
    },
  }],
}

describe('host 0.2.1: the sanctioned plugin-record transport', () => {
  it('detects the record writer on the installed host', () => {
    expect(pluginEventTransport(host)).toBe('plugin-record')
    expect(typeof host.appendPluginRecord).toBe('function')
  })

  it('writes a semantic record the host marks ignorable and retains', () => {
    const session = host.Session.create(host.SessionId('host-semantic-1'))
    appendPluginEvent(session as unknown as VendorSession, 'semantic', payload, host)
    // The validator normalizes its input in place; a session snapshot is frozen.
    const events = [...session.snapshotEvents()]
    expect(events).toHaveLength(1)
    const event = events[0] as { type: string; ignorable?: boolean; data: unknown }
    expect(event.type).toBe('plugin:epistemic-fold/semantic')
    expect(event.ignorable).toBe(true)
    // The host's persistence read path keeps the record rather than refusing
    // the log — the property that made `ef/anchor` unusable on this build.
    expect(() => hostPersistence.validateStoredEvents(headerOf('host-semantic-1'), events)).not.toThrow()
  })

  it('reads the record back through the host reader and EF guard', () => {
    const session = host.Session.create(host.SessionId('host-semantic-2'))
    appendPluginEvent(session as unknown as VendorSession, 'semantic', payload, host)
    const event = session.snapshotEvents()[0]!
    const record = efPluginRecordOf(event as never, host)
    expect(record?.kind).toBe('semantic')
    const semantic = semanticRecordOf(event as never)
    expect(semantic?.payload.packetId).toBe('packet-1')
    expect(semantic?.payload.ops).toHaveLength(1)
    const records = semanticRecordsIn(session as unknown as VendorSession)
    expect(records).toHaveLength(1)
    const state = projectSemanticRecords(emptyCurrentState(), records)
    expect(state.constraints['semantic-aaaa']!.value).toBe('The timeout is 30 seconds.')
  })

  it('shows the raw append path still drops the marker, which is why it is refused', () => {
    const session = host.Session.create(host.SessionId('host-raw-1'))
    const appended = session.append('ef/anchor', { op: 'retire', anchorId: 'x' }, { ignorable: true })
    expect(appended.ignorable).toBeUndefined()
    expect(host.pluginRecordOf(appended)).toBeUndefined()
    // ...and without the marker the read path refuses the log outright.
    expect(() => hostPersistence.validateStoredEvents(headerOf('host-raw-1'), [appended]))
      .toThrow()
  })

  it('refuses an unmarked record even when its type looks like a plugin record', () => {
    const session = host.Session.create(host.SessionId('host-raw-2'))
    appendPluginEvent(session as unknown as VendorSession, 'semantic', payload, host)
    const event = session.snapshotEvents()[0] as Record<string, unknown>
    const unmarked = {
      type: event.type, seq: event.seq, time: event.time, data: event.data,
    }
    expect(() => hostPersistence.validateStoredEvents(headerOf('host-raw-2'), [unmarked])).toThrow()
    // The type alone is not the authority: the envelope marker is. EF's own
    // reader refuses it on a host without a reader, too.
    expect(efPluginRecordOf(unmarked as never, host)).toBeUndefined()
    expect(efPluginRecordOf(unmarked as never)).toBeUndefined()
    expect(host.pluginRecordOf(unmarked)).toBeUndefined()
  })
})
