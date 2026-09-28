/**
 * Epistemic Fold: a contract-preserving context runtime for DeepSeek Harness.
 * Public surface: engine, policy face, candidate registry, bundle store,
 * compiler, frontier/leaf/root policies, deterministic state + projection,
 * structured renderer, bounded recall tools.
 *
 * @module dsh-epistemic-fold
 */

export { EpistemicFoldEngine, default } from './engine.ts'
export type { EpistemicFoldOptions } from './engine.ts'
export { createFoldCandidate, FoldCandidateRegistry } from './candidate.ts'
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
export { resolveEfConfig, resolveEfCompactSpec } from './policy.ts'
export type {
  EfCompactSpec,
  EpistemicFoldConfig,
  ResolvedEpistemicFoldConfig,
} from './policy.ts'
export { registerRecallTools } from './tools.ts'
export {
  registerEpistemicFoldProjection,
  currentFoldState,
  epistemicFoldProjection,
  EF_CURRENT_STATE_KEY,
} from './projection.ts'
export {
  authorityLossRate,
  emptyCurrentState,
  reduceEvent,
  stateKeyText,
  stateStalenessRate,
} from './state.ts'
export type {
  Anchor,
  AnchorKind,
  AnchorLifecycle,
  EfAnchorEventData,
  EventRef,
  FailureState,
  FoldCurrentState,
  StateKey,
} from './state.ts'
export { canVerify, groundableDomains, isAuthorityGrounded } from './authority.ts'
export type { AuthorityDomain } from './authority.ts'
export { renderStructuredCheckpoint } from './renderer.ts'
export type {
  BundleDescriptor,
  BundleVerification,
  BundleWriteResult,
  CheckpointBundleV1,
  FoldBundleStore,
  FoldCandidate,
  FoldMode,
  RecallPage,
} from './types.ts'
