/**
 * Typed readers for the session-event payloads EF inspects.
 *
 * `SessionEvent.data` is untyped by construction: the host cannot know a
 * plugin's event vocabulary, so every consumer narrows it inline. The same three
 * payloads were narrowed in both `status.ts` and `status-projection.ts`, and
 * that is the hazard rather than the repetition — two readers of one event shape
 * drift apart silently, and the field one of them reads stops matching the other
 * without any test noticing, because each is only ever exercised through its own
 * caller.
 *
 * Each reader narrows once, and a malformed payload yields `undefined` rather
 * than a wrong value: every caller is counting something, and a wrong count is
 * worse than a missing one.
 *
 * @module dsh-epistemic-fold/event-data
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One field of an untrusted payload, without narrowing it. */
function field(container: unknown, key: string): unknown {
  return (container as Record<string, unknown> | undefined)?.[key]
}

/** One field of an untrusted payload, when it is a string. */
function text(container: unknown, key: string): string | undefined {
  const value = field(container, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether a `compaction/end` reports a failure.
 *
 * Presence of `error`, not its type: the runtime writes a string, and a
 * malformed one still means the transaction failed.
 */
export function compactionFailed(event: SessionEvent): boolean {
  return field(event.data, 'error') !== undefined
}

/** The `reason` a `request/header` carries (`initial`, `resume`, `change`). */
export function requestHeaderReason(event: SessionEvent): string | undefined {
  return text(event.data, 'reason')
}

/**
 * The provider/model a `request/header` routes to.
 *
 * Each half is returned independently, because a header that names only one of
 * them must update that one and leave the other as it stands — collapsing the
 * pair into "a route" would silently discard a half-specified change.
 */
export function requestHeaderRoute(event: SessionEvent): {
  readonly provider?: string
  readonly model?: string
} {
  const config = field(field(event.data, 'header'), 'config')
  const provider = text(config, 'provider')
  const model = text(config, 'model')
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/** The tool name a `tool/call` invokes. */
export function toolCallName(event: SessionEvent): string | undefined {
  return text(event.data, 'name')
}
