/**
 * The plugin-event transport: the one place EF decides HOW a plugin-owned
 * durable log record is written.
 *
 * DSH 0.2.1 added `appendPluginRecord(session, type, data)`, the sanctioned
 * writer for an out-of-vocabulary event: it sets the envelope's `ignorable`
 * marker, keeps the record out of the model-visible surface, carries it
 * through fork and resume, and lets the persistence read path retain it. That
 * is the transport EF's anchors, retirements, and semantic commits use when it
 * is present.
 *
 * Older hosts have no such writer. `Session.append` builds the envelope itself
 * and cannot set `ignorable`, so a raw `ef/anchor` append is durable on a
 * persisting host and then makes the log unopenable. EF therefore reports
 * `none` there and the callers fail closed BEFORE the append.
 *
 * Three transports, chosen once per process by feature detection rather than
 * by version number, because the capability is per-build:
 *
 *   plugin-record   `appendPluginRecord` — durable, replayable, forkable.
 *   append-options  the pre-release option bag; the marker survives only on a
 *                   host whose `append` honors it (probed, never assumed).
 *   none            no safe writer; the caller must refuse.
 *
 * The reader (`efPluginRecordOf`) accepts both a `plugin:` record and the raw
 * `ef/anchor` / `ef/retire` events used by the in-memory face, so a session
 * written by either face replays through the same reducer.
 *
 * @module dsh-epistemic-fold/plugin-events
 */

import { randomUUID } from 'node:crypto'
import * as sessionApi from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType, SessionSeq } from '@deepseek-ai/dsh-session'

/** The logical EF record kinds; each maps to one transport type. */
export type EfPluginRecordKind = 'anchor' | 'retire' | 'semantic'

/** The `plugin:` names EF owns. Grammar: `plugin:` + slash-separated segments. */
export const EF_PLUGIN_RECORD_TYPES = {
  anchor: 'plugin:epistemic-fold/anchor',
  retire: 'plugin:epistemic-fold/retire',
  semantic: 'plugin:epistemic-fold/semantic',
} as const satisfies Record<EfPluginRecordKind, string>

/** The raw event types used by the pre-record face (in-memory and tests). */
const RAW_EVENT_TYPES: Record<EfPluginRecordKind, string> = {
  anchor: 'ef/anchor',
  retire: 'ef/retire',
  semantic: 'ef/semantic',
}

/** How this host admits a plugin-owned durable session event. */
export type PluginEventTransport = 'plugin-record' | 'append-options' | 'none'

/**
 * The two host functions this module needs, typed structurally.
 *
 * A namespace import is used so a host that predates the API yields
 * `undefined` instead of failing at module link time; the structural type
 * then keeps every call checked without an `any` cast.
 */
export interface PluginEventApi {
  readonly appendPluginRecord?: (
    session: SessionType,
    type: string,
    data: unknown,
  ) => number
  readonly pluginRecordOf?: (event: unknown) => {
    readonly type: string
    readonly seq: number
    readonly time: number
    readonly data: unknown
  } | undefined
}

/** The namespace object of the installed `@deepseek-ai/dsh-session`. */
export const DEFAULT_PLUGIN_EVENT_API: PluginEventApi = sessionApi as unknown as PluginEventApi

let cachedDefaultTransport: PluginEventTransport | undefined

/**
 * Detect how this host admits a plugin-owned durable event.
 *
 * The `plugin-record` answer is a property check, not a version table: a host
 * either exports the sanctioned writer or it does not. The `append-options`
 * fallback probes the envelope `append` actually returns, because a host that
 * drops the option bag would otherwise look capable and poison every persisted
 * log it writes.
 *
 * @param api - the session API to probe; the installed namespace by default.
 * @returns the transport in force for this process.
 */
export function pluginEventTransport(api: PluginEventApi = DEFAULT_PLUGIN_EVENT_API): PluginEventTransport {
  if (api === DEFAULT_PLUGIN_EVENT_API && cachedDefaultTransport !== undefined) return cachedDefaultTransport
  const transport = detect(api)
  if (api === DEFAULT_PLUGIN_EVENT_API) cachedDefaultTransport = transport
  return transport
}

function detect(api: PluginEventApi): PluginEventTransport {
  if (typeof api.appendPluginRecord === 'function') return 'plugin-record'
  return appendOptionsPreservesMarker() ? 'append-options' : 'none'
}

/**
 * Whether the legacy option bag survives `append` on this build.
 *
 * The probe keeps calling `append` as a member: pulling the method into a
 * variable would drop its receiver and throw, and the catch would then report
 * "unsupported host" for the wrong reason.
 */
function appendOptionsPreservesMarker(): boolean {
  try {
    const probe = Session.create(SessionId(`ef-capability-probe-${randomUUID()}`))
    const untyped = probe as unknown as {
      append(type: string, data: unknown, opts: unknown): { readonly ignorable?: unknown }
    }
    const appended = untyped.append(
      'ef/anchor',
      { op: 'retire', anchorId: 'capability-probe' },
      { ignorable: true },
    )
    return appended.ignorable === true
  } catch {
    // A host that rejects the options bag is no more usable than one that
    // drops it; both mean the same thing here.
    return false
  }
}

/**
 * Whether EF may write a durable plugin record on this host.
 *
 * The in-memory face default (`true`) belongs to the CALLER, not here: the
 * anchor service and the semantic journal decide whether their deployment
 * persists a log at all.
 */
export function hostAdmitsPluginEvents(api: PluginEventApi = DEFAULT_PLUGIN_EVENT_API): boolean {
  return pluginEventTransport(api) !== 'none'
}

/**
 * Write one EF record through the transport in force.
 *
 * @throws when no transport can make the record durable; the caller is expected
 *   to have refused earlier, and this throw is the defense in depth that keeps
 *   a caller which forgot from writing an unopenable log.
 * @returns the committed record's sequence number, or `undefined` on the
 *   legacy option-bag transport (whose `append` returns an event, not a seq).
 */
export function appendPluginEvent(
  session: SessionType,
  kind: EfPluginRecordKind,
  data: unknown,
  api: PluginEventApi = DEFAULT_PLUGIN_EVENT_API,
): SessionSeq | undefined {
  const transport = pluginEventTransport(api)
  if (transport === 'plugin-record') {
    const append = api.appendPluginRecord
    /* v8 ignore next -- detect() guarantees the function on this branch. */
    if (append === undefined) throw new Error('epistemic-fold: plugin-record transport without appendPluginRecord')
    // The host types the record name against its PluginRecordMap, which a
    // downstream package cannot augment from here; the grammar is the same
    // contract, and the host validates it at append time.
    return append(session, EF_PLUGIN_RECORD_TYPES[kind], data) as SessionSeq
  }
  if (transport === 'append-options') {
    const untyped = session as unknown as {
      append(type: string, payload: unknown, opts: unknown): { readonly seq: SessionSeq }
    }
    return untyped.append(RAW_EVENT_TYPES[kind], data, { ignorable: true }).seq
  }
  throw new Error(
    'epistemic-fold: refusing to append a plugin-owned session event — this DSH host has no sanctioned '
    + 'plugin-record writer, and `Session.append` cannot mark the event `ignorable`. The persistence read '
    + 'path refuses to reopen a log containing an unknown event type without that marker. See README, '
    + '"State ownership".',
  )
}

/**
 * Append one EF event, with an EXPLICIT in-memory fallback.
 *
 * `inMemoryFallback` is not a convenience: it states that the caller's
 * deployment does not persist this log, so a raw `ef/*` event is the correct
 * record (it replays through the same reducer). A persisting deployment must
 * never take that branch — its guard refuses before reaching here.
 *
 * @param session - the log to append to.
 * @param kind - the logical record kind.
 * @param data - the record payload.
 * @param options - the caller's in-memory claim and the session API to use.
 */
export function appendEfEvent(
  session: SessionType,
  kind: EfPluginRecordKind,
  data: unknown,
  options: { readonly inMemoryFallback?: boolean; readonly api?: PluginEventApi } = {},
): void {
  const api = options.api ?? DEFAULT_PLUGIN_EVENT_API
  if (options.inMemoryFallback === true && pluginEventTransport(api) === 'none') {
    const untyped = session as unknown as { append(type: string, payload: unknown): unknown }
    untyped.append(RAW_EVENT_TYPES[kind], data)
    return
  }
  appendPluginEvent(session, kind, data, api)
}

/** One EF record read back from the log, whichever face wrote it. */
export interface EfPluginRecord {
  readonly kind: EfPluginRecordKind
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * Read one committed event as an EF plugin record.
 *
 * `plugin:` records go through the host's own reader when it exists, so the
 * `ignorable` and grammar rules are the host's, not a re-implementation. Raw
 * `ef/*` events are accepted for the in-memory face and for logs written
 * before the plugin-record transport existed.
 *
 * @returns the EF record, or `undefined` for any unrelated event.
 */
export function efPluginRecordOf(
  event: {
    readonly type: string
    readonly seq: number
    readonly time?: number
    readonly data: unknown
    readonly ignorable?: unknown
  },
  api: PluginEventApi = DEFAULT_PLUGIN_EVENT_API,
): EfPluginRecord | undefined {
  const type: string = event.type
  const rawKind = (Object.keys(RAW_EVENT_TYPES) as EfPluginRecordKind[])
    .find(kind => RAW_EVENT_TYPES[kind] === type)
  if (rawKind !== undefined) {
    return { kind: rawKind, seq: event.seq, time: event.time ?? 0, data: event.data }
  }
  const recordType = (Object.keys(EF_PLUGIN_RECORD_TYPES) as EfPluginRecordKind[])
    .find(kind => EF_PLUGIN_RECORD_TYPES[kind] === type)
  if (recordType === undefined) return undefined
  if (api.pluginRecordOf === undefined) {
    // A host without the reader still lets us replay a record we recognize by
    // type — but ONLY the envelope marker makes it a safe-to-skip record. A
    // `plugin:`-shaped type without it is a required event this build does not
    // understand, and treating it as an EF record would silently discard
    // whatever it actually meant.
    if (event.ignorable !== true) return undefined
    return { kind: recordType, seq: event.seq, time: event.time ?? 0, data: event.data }
  }
  const record = api.pluginRecordOf(event)
  if (record === undefined || record.type !== type) return undefined
  return { kind: recordType, seq: record.seq, time: record.time, data: record.data }
}

/**
 * Every EF record in a session log, in commit order.
 *
 * @param events - the session's events in seq order.
 * @returns only the records EF owns.
 */
export function efPluginRecordsIn(
  events: Iterable<{ readonly type: string; readonly seq: number; readonly time?: number; readonly data: unknown }>,
  api: PluginEventApi = DEFAULT_PLUGIN_EVENT_API,
): readonly EfPluginRecord[] {
  const records: EfPluginRecord[] = []
  for (const event of events) {
    const record = efPluginRecordOf(event, api)
    if (record !== undefined) records.push(record)
  }
  return records
}

/** The error message a refused write raises, shared by every caller. */
export const PLUGIN_EVENT_REFUSAL =
  'epistemic-fold: refusing to append a plugin-owned session event — this DSH host has no sanctioned '
  + 'plugin-record writer, and `Session.append` cannot mark the event `ignorable`.'
