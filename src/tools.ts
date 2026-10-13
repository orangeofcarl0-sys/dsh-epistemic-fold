/**
 * Model-facing recall tools: `context_search` and `context_recall`
 * (RFC-001 §8). Registration is explicit — the host mounts them against one
 * bundle store; `context_search` scopes results to the calling agent's
 * session, `context_recall` is store-global by checkpoint id.
 *
 * @module dsh-epistemic-fold/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { sessionEventSource } from './archive-refs.ts'
import type { LogReader } from './archive-refs.ts'
import type { FoldBundleStore } from './types.ts'
import { CHECKPOINT_MARKER_EXPLANATION, normalizeCheckpointRef } from './checkpoint-marker.ts'
import { EXACT_PAGE_LIMIT, recall, recallForeign, search } from './recall.ts'
import type { RecallDepth } from './recall.ts'
import { routedTarget } from './policy.ts'
import {
  completeWithContext,
  describeCheckpoint,
  estimateRenderedChars,
  recallBudgetVerdict,
  runSubagentRecall,
  SUBAGENT_MAX_DESCRIPTORS,
  subagentRecallStats,
} from './subagent-recall.ts'
import type { CheckpointDescriptor } from './subagent-recall.ts'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/** Tool canonical values must be lossless JSON; strip class identities. */
function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** EXPERIMENTAL wiring for subagent recall; present only when the flag is on. */
export interface SubagentRecallWiring {
  /** Rendered characters a direct recall may return before it is refused. */
  readonly thresholdChars: number
  /** Characters of archive one subagent run may read. */
  readonly fetchBudgetChars: number
}

/** The descriptor of one checkpoint, or `undefined` when it cannot be read. */
async function describeOne(
  store: FoldBundleStore,
  sessionId: SessionId,
  ref: string,
  session: Session,
): Promise<CheckpointDescriptor | undefined> {
  const verification = await store.verify(sessionId, normalizeCheckpointRef(ref))
  if (verification.status === 'missing' || verification.status === 'corrupt') return undefined
  return describeCheckpoint(verification.bundle, sessionEventSource(session))
}

/**
 * Descriptors for the planner, newest first and bounded.
 *
 * Newest first because a question is usually about the recent past, and bounded because
 * the list goes into a prompt. Older checkpoints stay reachable through the search the
 * planner is told to use when no descriptor obviously holds the answer.
 */
async function describeSession(
  store: FoldBundleStore,
  sessionId: SessionId,
  session: Session,
): Promise<CheckpointDescriptor[]> {
  const listed = await store.list(sessionId)
  const newest = listed.slice(Math.max(0, listed.length - SUBAGENT_MAX_DESCRIPTORS)).reverse()
  const out: CheckpointDescriptor[] = []
  for (const entry of newest) {
    const bundle = await store.read(sessionId, entry.checkpointId)
    if (bundle === null) continue
    out.push(describeCheckpoint(bundle, sessionEventSource(session)))
  }
  return out
}

/** Optional wiring for the two experiments. */
export interface RecallToolOptions {
  /**
   * Reads another session's stored log, for a checkpoint whose session is not
   * loaded. Only supplied when `allowCrossSessionRecall` is on.
   */
  readonly logReader?: LogReader
  /**
   * Subagent recall (docs/67). ABSENT means the feature is off: `context_recall`
   * behaves exactly as it always has, and `context_recall_subagent` is not registered
   * at all. A default deployment therefore cannot observe this feature.
   */
  readonly subagentRecall?: SubagentRecallWiring
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
      // ONE payload, so the size gate below cannot be bypassed by the foreign path.
      const payload: unknown = result !== null
        ? result
        : options.logReader === undefined
          ? { checkpointId: ref, unavailable: 'bundle not found' }
          : await recallForeign({
            store,
            requesting: agent.session.id,
            logReader: options.logReader,
            checkpointId: ref,
            ...(depth === undefined ? {} : { depth }),
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
          }) ?? { checkpointId: ref, unavailable: 'bundle not found' }

      // EXPERIMENTAL (docs/67): a recall that would return more than the caller can afford
      // is REFUSED, and the refusal names the problem and the way through it. Only under
      // `subagentRecall`, so a default deployment sees the old behaviour exactly.
      const wiring = options.subagentRecall
      if (wiring !== undefined) {
        const verdict = recallBudgetVerdict(estimateRenderedChars(payload), wiring.thresholdChars)
        if (!verdict.allowed) {
          subagentRecallStats.gated += 1
          return asJsonValue({
            checkpointId: ref,
            overBudget: true,
            projectedChars: verdict.projectedChars,
            estimatedTokens: verdict.estimatedTokens,
            thresholdChars: verdict.thresholdChars,
            overBy: verdict.overBy,
            descriptor: await describeOne(store, agent.session.id, ref, agent.session),
            suggestion:
              'This recall would return about ' + verdict.estimatedTokens + ' tokens (an estimate at 4 '
              + 'characters per token), over the ' + wiring.thresholdChars + '-character direct limit. '
              + 'Call context_recall_subagent with the goal you are trying to answer (and this ref '
              + 'as scope if you know it): a retrieval subagent reads the archive and returns only '
              + 'what answers the goal, plus what else it saw that you may want next.',
            alternatives: [
              'context_recall with a smaller limit returns one page',
              'context_recall_subagent with no goal returns a survey of what the archive holds',
            ],
          })
        }
      }
      return asJsonValue(payload)
    },
    isConcurrencySafe: () => true,
  })

  /**
   * EXPERIMENTAL (docs/67): retrieval as a bounded QUERY rather than a document fetch.
   *
   * The caller states a GOAL; a subagent reads the archive and answers in a bounded reply,
   * plus a `further` list of what else it saw that the caller may want next. Registered
   * ONLY when `subagentRecall` is on, so a default deployment has no such tool.
   */
  const contextRecallSubagent = defineTool({
    name: 'context_recall_subagent',
    description:
      'Ask a RETRIEVAL SUBAGENT about folded history instead of fetching it yourself. Give it a GOAL '
      + 'in your own words; it reads the archive (descriptors, search, exact pages) and returns a short '
      + 'answer, any verbatim QUOTES the answer rests on, and a FURTHER list of what else it saw that you '
      + 'may want next. Use this instead of context_recall when the content would be large, or when you '
      + 'do not know which checkpoint holds the answer. Call it with NO goal to get a SURVEY of what the '
      + 'archive holds, which is how you discover what to ask for.',
    parameters: {
      goal: { type: 'string', description: 'what you want to know, in your own words; omit for a survey' },
      ref: { type: 'string', description: 'optional scope: one checkpoint, e.g. `cp:<id>`' },
      query: { type: 'string', description: 'optional scope: a search query' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(JSON.stringify(value, null, 2))],
    },
    async execute(args, exec) {
      const { goal, ref, query } = args as { goal?: string; ref?: string; query?: string }
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('context_recall_subagent requires an executing agent session')
      }
      const wiring = options.subagentRecall
      if (wiring === undefined) {
        return asJsonValue({ unavailable: 'subagent recall is not enabled in this deployment' })
      }
      const target = routedTarget(agent.session)
      if (target === undefined) {
        return asJsonValue({ unavailable: 'no routed model to run the retrieval subagent' })
      }
      const sessionId = agent.session.id
      const source = sessionEventSource(agent.session)
      try {
        const descriptors = await describeSession(store, sessionId, agent.session)
        const answer = await runSubagentRecall({
          ...(goal === undefined ? {} : { goal }),
          ...(ref === undefined ? {} : { ref }),
          ...(query === undefined ? {} : { query }),
          descriptors,
          fetchBudgetChars: wiring.fetchBudgetChars,
          fetch: async request => {
            const result = await recall({
              store,
              sessionId,
              checkpointId: request.ref,
              depth: request.depth,
              ...(request.offset === undefined ? {} : { offset: request.offset }),
              limit: request.limit ?? EXACT_PAGE_LIMIT,
              source,
            })
            if (result === null) return null
            const text = JSON.stringify(result)
            return { text, chars: text.length }
          },
          search: async q => {
            const hits = await search({ store, sessionId, query: q, source })
            const text = JSON.stringify({ hits })
            return { text, chars: text.length }
          },
          complete: (messages, maxTokens) => completeWithContext({
            ctx, target, sessionId, messages, maxTokens,
          }),
        })
        return asJsonValue(answer)
      } catch (error) {
        // A retrieval helper that can end an episode is worse than one that reports it
        // could not help: the caller keeps its turn and can fall back to context_recall.
        subagentRecallStats.failures += 1
        subagentRecallStats.lastError = error instanceof Error ? error.message : String(error)
        return asJsonValue({
          unavailable: 'the retrieval subagent failed',
          error: subagentRecallStats.lastError,
        })
      }
    },
    isConcurrencySafe: () => true,
  })

  const disposeSearch = ctx.tools.register(contextSearch)
  const disposeRecall = ctx.tools.register(contextRecall)
  const disposeSubagent = options.subagentRecall === undefined
    ? undefined
    : ctx.tools.register(contextRecallSubagent)
  return () => {
    disposeSearch()
    disposeRecall()
    if (disposeSubagent !== undefined) disposeSubagent()
  }
}
