/**
 * Deterministic checkpoint descriptors for the retrieval subagent (docs/67).
 *
 * No model call here, so an EF leaf fold still makes zero auxiliary calls and
 * this adds nothing to its cost or latency. The span is `sourceRangeOf` from
 * `recall.ts`, so a descriptor orders by the same source chronology the search
 * layer does rather than recomputing it.
 *
 * The inventory BUILDERS live in `inventory.ts`; see that module for why. They are
 * re-exported here so the `subagent-recall.ts` barrel and every existing importer keep
 * the same surface.
 *
 * @module dsh-epistemic-fold/descriptors
 */

import type { EventSource } from "./archive-refs.ts"
import { inventoryOf } from "./inventory.ts"
import { archiveMessages, sourceRangeOf } from "./recall.ts"
import type { CheckpointBundleV1 } from "./types.ts"

export * from "./inventory.ts"

// ---------------------------------------------------------------- descriptors

/**
 * What a checkpoint holds, in words a model can reason with.
 *
 * The alternative — the checkpoint marker, `[EF1 L cp:<uuid>]` — names a location and
 * nothing else, which is what made targeting fail: the retrieval decision is a match
 * between "what I need" and "what was dropped", and an id supplies neither side.
 *
 * Everything here is DETERMINISTIC. No model call, so an EF leaf fold still makes zero
 * auxiliary calls and this adds nothing to its cost or latency.
 */
export interface CheckpointDescriptor {
  /** The handle to fetch with, e.g. `cp:56aee82f`. */
  readonly handle: string
  readonly mode: string
  /** Where in the conversation it sits, as the surface positions the fold recorded. */
  readonly span?: { readonly first: number; readonly last: number }
  readonly messageCount: number
  /** One line per archived message: role, tool name, and a leading excerpt. */
  readonly inventory: readonly string[]
}

/**
 * The descriptor of one bundle.
 *
 * An archive that cannot be resolved yields a descriptor with no inventory and an
 * explicit note, rather than an empty one: "I could not read this" and "this is empty"
 * are different claims and a caller acting on the wrong one is how a fact gets reported
 * as unknown.
 */
export function describeCheckpoint(
  bundle: CheckpointBundleV1,
  source?: EventSource,
): CheckpointDescriptor {
  const span = sourceRangeOf(bundle)
  const resolved = archiveMessages(bundle, source)
  const inventory = resolved.status === "resolved"
    ? inventoryOf(resolved.messages)
    : ["(archive unreadable: " + resolved.failures.map(f => f.reason).join(", ") + ")"]
  return {
    handle: bundle.checkpointId,
    mode: bundle.mode,
    ...(span === undefined ? {} : { span }),
    messageCount: bundle.archive.messageCount,
    inventory,
  }
}
