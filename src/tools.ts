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
import type { FoldBundleStore } from './types.ts'
import { CHECKPOINT_MARKER_EXPLANATION } from './checkpoint-marker.ts'
import { EXACT_PAGE_LIMIT, recall, search } from './recall.ts'
import type { RecallDepth } from './recall.ts'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/** Tool canonical values must be lossless JSON; strip class identities. */
function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Register the two recall tools against `ctx.tools` (the ToolRuntime service).
 * @returns the exact disposer that unregisters both tools.
 */
export function registerRecallTools(ctx: Context, store: FoldBundleStore): () => void {
  const contextSearch = defineTool({
    name: 'context_search',
    description:
      'Search this session\'s folded checkpoints (checkpoint ids, checkpoint text, tool names, message text). '
      + 'Each hit reports `matchKind`: `checkpoint-text` means the query matched the checkpoint summary already '
      + 'on the surface, while `message-text` / `tool-name` mean it matched the ARCHIVED history — the excerpt is '
      + 'a short preview, and `exactPageOffset` is the `context_recall` page holding the full text. A hit is a '
      + 'pointer, not the answer: recall the page when the excerpt is not enough to answer.',
    parameters: {
      query: { type: 'string', description: 'search text, file path, tool name, or checkpoint id' },
      limit: { type: 'integer', description: 'maximum hits to return (default 10)' },
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
      const result = await recall({
        store,
        sessionId: agent.session.id,
        checkpointId: ref,
        ...(depth === undefined ? {} : { depth }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      })
      return asJsonValue(result ?? { checkpointId: ref, unavailable: 'bundle not found' })
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
