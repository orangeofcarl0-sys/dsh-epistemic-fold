/**
 * Epistemic Fold: a contract-preserving context runtime for DeepSeek Harness.
 * M0 surface: engine, candidate registry, bundle store, compiler, recall.
 *
 * @module dsh-epistemic-fold
 */

export { EpistemicFoldEngine, default } from './engine.ts'
export type { EpistemicFoldOptions } from './engine.ts'
export { CheckpointId, createFoldCandidate, FoldCandidateRegistry } from './candidate.ts'
export { FileBundleStore } from './bundle-store.ts'
export {
  buildBundle,
  frameCheckpoint,
  renderFallbackCheckpoint,
  renderSemanticCheckpoint,
  splitSummarizationInput,
} from './compiler.ts'
export type { SplitSummarizationInput } from './compiler.ts'
export { canonicalHash, canonicalJson, sha256Hex } from './hash.ts'
export { recall, search, EXACT_PAGE_LIMIT } from './recall.ts'
export type { RecallDepth, RecallResult, SearchHit } from './recall.ts'
export { registerRecallTools } from './tools.ts'
export type {
  BundleDescriptor,
  BundleVerification,
  BundleWriteResult,
  CheckpointBundleV1,
  FoldBundleStore,
  FoldCandidate,
  FoldMode,
  FoldSession,
  RecallPage,
} from './types.ts'
