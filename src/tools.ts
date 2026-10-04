/**
 * Model-facing recall tools: `context_search` and `context_recall`
 * (RFC-001 §8). Registration is explicit — the host mounts them against one
 * bundle store; `context_search` scopes results to the calling agent's
 * session, `context_recall` is store-global by checkpoint id.
 *
 * @module dsh-epistemic-fold/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { sessionEventSource } from './archive-refs.ts'
import type { LogReader } from './archive-refs.ts'
import type { FoldBundleStore } from './types.ts'
import { CHECKPOINT_MARKER_EXPLANATION } from './checkpoint-marker.ts'
import { EXACT_PAGE_LIMIT, recall, recallForeign, search } from './recall.ts'
import type { RecallDepth } from './recall.ts'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/** Tool canonical values must be lossless JSON; strip class identities. */
function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Optional wiring for the cross-session experiment. */
export interface RecallToolOptions {
  /**
   * Reads another session's stored log, for a checkpoint whose session is not
   * loaded. Only supplied when `allowCrossSessionRecall` is on.
   */
  readonly logReader?: LogReader
}

/**
 * Register the two recall tools against `ctx.tools` (the ToolRuntime service).
 * @param ctx - the context carrying `tools`.
 * @param store - the bundle store to serve from.
 * @param options - cross-session wiring; omitted in a default deployment.
 * @returns the exact disposer that unregisters both tools.
 */
export function registerRecallTools(
  ctx: Context,
  store: FoldBundleStore,
  options: RecallToolOptions = {},
): () => void {
  const contextSearch = defineTool({
    name: 'context_search',
    description:
      'Search this session\'s folded checkpoints (checkpoint ids, checkpoint text, tool names, message text). '
      + 'Hits are returned NEWEST FIRST by conversation position, so the first hit is the most recent statement '
      + 'of what you searched for — when a fact changed over time, read the first hit, not the last. '
      + 'Each hit reports `matchCount`: a count above 1 means this fact has history, and '
      + '`earliestMatchedMessageIndex` locates the superseded version. `matchKind` says where it matched: '
      + '`checkpoint-text` means the query matched the checkpoint summary already on the surface, while '
      + '`message-text` / `tool-name` mean it matched the ARCHIVED history. A hit is a pointer, not the answer: '
      + '`matchedMessageIndex` is the `offset` for context_recall with `depth: "exact"`, whose page then begins '
      + 'at the match.',
    parameters: {
      query: { type: 'string', description: 'search text, file path, tool name, or checkpoint id' },
      limit: { type: 'integer', description: 'maximum hits to return (default 10, most recent first)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(JSON.stringify(value, null, 2))],
    },
    async execute(args, exec) {
      const { query, limit } = args as { query: string; limit?: number }
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('context_search requires an executing agent session')
      }
      const hits = await search({
        store,
        sessionId: agent.session.id,
        query,
        ...(limit === undefined ? {} : { limit }),
        // The live session resolves a REFERENTIAL archive without touching
        // disk: `eventAt(seq)` is an in-memory index and `deriveEventMessage`
        // is pure. Passing it costs nothing when archives are inline.
        source: sessionEventSource(agent.session),
      })
      return asJsonValue({ hits })
    },
    isConcurrencySafe: () => true,
  })

  const contextRecall = defineTool({
    name: 'context_recall',
    description:
      `${CHECKPOINT_MARKER_EXPLANATION} depth=summary returns the checkpoint view; depth=detail adds the `
      + 'semantic digest; depth=exact returns one bounded page of the archived model history.',
    parameters: {
      ref: { type: 'string', description: 'checkpoint reference, e.g. `cp:<id>` from a checkpoint marker' },
      depth: { type: 'string', enum: ['summary', 'detail', 'exact'], description: 'recall depth (default summary)' },
      offset: { type: 'integer', description: 'exact-depth page offset' },
      limit: { type: 'integer', description: `exact-depth page size (max ${EXACT_PAGE_LIMIT})` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(JSON.stringify(value, null, 2))],
    },
    async execute(args, exec) {
      const { ref, depth, offset, limit } = args as {
        ref: string
        depth?: RecallDepth
        offset?: number
        limit?: number
      }
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('context_recall requires an executing agent session')
      }
      // The store refuses a checkpoint belonging to another session, so a
      // foreign ref can only be served when the cross-session experiment is on.
      // The live session is tried first: it is the in-memory, zero-I/O path and
      // is correct for this session's own checkpoints in every configuration.
      const result = await recall({
        store,
        sessionId: agent.session.id,
        checkpointId: ref,
        ...(depth === undefined ? {} : { depth }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
        source: sessionEventSource(agent.session),
      })
      if (result !== null) return asJsonValue(result)

      if (options.logReader === undefined) {
        return asJsonValue({ checkpointId: ref, unavailable: 'bundle not found' })
      }
      const foreign = await recallForeign({
        store,
        requesting: agent.session.id,
        logReader: options.logReader,
        checkpointId: ref,
        ...(depth === undefined ? {} : { depth }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      })
      return asJsonValue(foreign ?? { checkpointId: ref, unavailable: 'bundle not found' })
    },
    isConcurrencySafe: () => true,
  })

  const disposeSearch = ctx.tools.register(contextSearch)
  const disposeRecall = ctx.tools.register(contextRecall)
  return () => {
    disposeSearch()
    disposeRecall()
  }
}
