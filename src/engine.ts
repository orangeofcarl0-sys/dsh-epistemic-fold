/**
 * The Epistemic Fold compaction engine: Basic's transaction with EF's
 * archive-before-loss compile hook.
 *
 * Transaction shape (RFC-001 §6, plan §7.1 correction):
 *   candidate prepared → Basic opens its transaction → summarize() archives
 *   the shadowed span, runs the semantic call, publishes the FINAL immutable
 *   bundle atomically, then returns the checkpoint text. Basic commits the
 *   surface replacement only after summarize() returns, so a durable bundle
 *   always precedes surface loss (BundleDurable ≺ SurfaceLoss). A bundle
 *   publish failure throws out of summarize(), which aborts the transaction
 *   with the surface unchanged; a bundle published but a later Basic failure
 *   leaves a detectable orphan that GC may collect.
 *
 * @module dsh-epistemic-fold/engine
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { createFoldCandidate, FoldCandidateRegistry } from './candidate.ts'
import {
  buildBundle,
  frameCheckpoint,
  renderFallbackCheckpoint,
  renderSemanticCheckpoint,
  splitSummarizationInput,
} from './compiler.ts'
import { FileBundleStore } from './bundle-store.ts'
import type { CheckpointBundleV1, FoldBundleStore, SummarizationInput, SummaryResult } from './types.ts'

export interface EpistemicFoldOptions {
  /** Durable bundle destination; defaults to `.epistemic-fold/bundles`. */
  readonly bundleStore?: FoldBundleStore
}

/**
 * Compaction backend implementing the Epistemic Fold runtime. `summarize()`
 * is EF's compile hook: the sole place where the archive is built and the
 * bundle is published, always before Basic can commit any lossy replacement.
 */
export class EpistemicFoldEngine extends BasicCompactionEngine {
  static override inject = BasicCompactionEngine.inject

  private readonly candidates = new FoldCandidateRegistry()
  private readonly bundles: FoldBundleStore
  /** Last bundle published by this engine (per transaction, for tests/telemetry). */
  private lastPublishedBundle: CheckpointBundleV1 | undefined

  constructor(ctx: ConstructorParameters<typeof BasicCompactionEngine>[0], options: EpistemicFoldOptions = {}) {
    super(ctx)
    this.bundles = options.bundleStore ?? new FileBundleStore('.epistemic-fold/bundles')
  }

  /** The bundle store this engine publishes checkpoints into. */
  get bundleStore(): FoldBundleStore {
    return this.bundles
  }

  /** Most recent bundle this engine published; `undefined` before the first fold. */
  get publishedBundle(): CheckpointBundleV1 | undefined {
    return this.lastPublishedBundle
  }

  /**
   * Fold one explicitly selected surface span as a LEAF fold: the candidate
   * is prepared first so the summarize hook knows the fold identity, and
   * cleared in a `finally` so cancellation or failure never leaks the slot.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ) {
    const candidate = createFoldCandidate({
      mode: 'leaf',
      session: agent.session,
      start,
      end,
    })
    this.candidates.prepare(agent.session, candidate)
    try {
      return await super.compactRegion(start, end, agent, signal)
    } finally {
      this.candidates.clear(agent.session)
    }
  }

  /**
   * Manual idle-session compaction is a ROOT fold by definition (D-004): the
   * manual path never goes through `compactRegion`, so the summarize hook
   * observes no pending candidate and prepares the implicit root candidate.
   */
  override async compactNow(
    ...args: Parameters<BasicCompactionEngine['compactNow']>
  ) {
    return super.compactNow(...args)
  }

  /**
   * The EF compile hook: archive the exact shadowed messages, run the semantic
   * call, publish the final bundle atomically, then hand Basic the checkpoint.
   * Semantic failures fall back deterministically WITHOUT entering Basic's
   * `compaction/summary-error` recovery — that recovery may rewrite the
   * selected input, which would break the prepared candidate identity.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const session = agent.session
    const candidate = this.candidates.get(session)
      ?? createFoldCandidate({ mode: 'root', session })
    const { contextPrefix, shadowedMessages } = splitSummarizationInput(input)
    const orderedSurfaceSeqs = this.currentSpanSeqs(agent, candidate, contextPrefix.length > 0)

    // The fallback SummaryResult that lands if the semantic call fails. The
    // transaction stays a success for Basic: the bundle is durable and the
    // checkpoint is deterministic — never a summary-error recovery.
    const fallbackText = frameCheckpoint(
      renderFallbackCheckpoint(candidate, shadowedMessages.length),
    )

    const publish = async (semanticText: string | undefined): Promise<SummaryResult> => {
      const renderedText = semanticText === undefined
        ? fallbackText
        : frameCheckpoint(renderSemanticCheckpoint(candidate, semanticText))
      const bundle = buildBundle({
        candidate,
        orderedSurfaceSeqs,
        shadowedMessages,
        renderedText,
        ...(semanticText === undefined ? {} : { semanticText }),
      })
      await this.bundles.write(bundle)
      this.lastPublishedBundle = bundle
      return {
        summary: [{ type: 'text', text: renderedText }],
        provider: semanticText === undefined ? 'epistemic-fold' : 'epistemic-fold-semantic',
        model: semanticText === undefined ? 'deterministic-fallback' : 'unspecified',
      }
    }

    // Semantic call with deterministic fallback: cancellation propagates,
    // every other failure lands the bounded fallback checkpoint (D-006:
    // narrative is advisory; the archive is the authority).
    let semanticText: string | undefined
    try {
      const semantic = await super.summarize(input, agent, signal)
      const text = semantic.summary
        .map(block => block.type === 'text' ? block.text : '')
        .join('\n')
        .trim()
      if (text.length > 0) semanticText = text
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      return await publish(undefined)
    }
    return await publish(semanticText)
  }

  /**
   * Surface seqs of the span being folded, read fresh when the hook runs.
   * The candidate's start/end name surface positions at prepare time; Basic
   * revalidated the span before the summarize call, so the current surface
   * still contains both boundaries.
   */
  private currentSpanSeqs(
    agent: Agent,
    candidate: ReturnType<FoldCandidateRegistry['get']>,
    hasSystemHead: boolean,
  ): readonly SessionSeq[] {
    const nodes = agent.session.surface.nodes
    if (candidate?.start !== undefined && candidate.end !== undefined) {
      const startIdx = nodes.indexOf(candidate.start)
      const endIdx = nodes.indexOf(candidate.end)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        return nodes.slice(startIdx, endIdx + 1)
      }
    }
    // Implicit root fold: everything currently on the surface except the
    // system head node, which the summarization input retains unshadowed.
    if (hasSystemHead && nodes.length > 0) return nodes.slice(1)
    return [...nodes]
  }
}

export default EpistemicFoldEngine
