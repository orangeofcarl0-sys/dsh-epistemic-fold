/**
 * Epistemic Fold: a contract-preserving context runtime for DeepSeek Harness.
 * Public surface: engine, policy face, candidate registry, bundle store,
 * compiler, frontier/leaf/root policies, deterministic state + projection,
 * structured renderer, bounded recall tools.
 *
 * @module dsh-epistemic-fold
 */

export { EpistemicFoldEngine, default } from './engine.ts'
export type { EpistemicFoldOptions, LeafAdmissionVerdict } from './engine.ts'
export { efOwnedConfigKeys } from './engine.ts'
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
export {
  compareCheckpointRecencyDescending,
  recall,
  search,
  sourceRangeOf,
  EXACT_PAGE_LIMIT,
} from './recall.ts'
export type {
  RecallDepth,
  RecallResult,
  SearchHit,
  SearchMatchKind,
  SourceRange,
} from './recall.ts'
export { resolveEfConfig, resolveEfCompactSpec, DEFAULT_RETAIN_RATIO } from './policy.ts'
export type {
  EfCompactSpec,
  EpistemicFoldConfig,
  LeafAdmissionMode,
  ResolvedEpistemicFoldConfig,
} from './policy.ts'
export {
  BALANCED_RETAIN_RATIO,
  FOLD_MODE_NAMES,
  QUALITY_RETAIN_RATIO,
  TIERS,
  TIER_MODE_NAMES,
  economyPresetValues,
  isFoldModeName,
  isTierModeName,
  presetOverrides,
  resolvePreset,
  tierLadder,
  tierLadderToText,
  tierValuesFor,
} from './preset.ts'
export type {
  FoldModeName,
  PresetOverride,
  TierDefinition,
  TierEvidenceStatus,
  TierModeName,
  TierSummary,
} from './preset.ts'
export {
  cacheRealizationRate,
  classifyRegime,
  costOf,
  effectiveRho,
  modeledCost,
  overrideProfile,
  parseEconomicsProfile,
  profileMatchesModel,
  rhoOf,
  rootBreakEvenRequests,
  selectProfile,
  tierFor,
} from './economics-profile.ts'
export type {
  ContextEconomicsProfile,
  CostBreakdown,
  ObservedUsage,
  PolicyRegime,
  PricingTier,
} from './economics-profile.ts'
export { compileContextPolicy } from './policy-compiler.ts'
export type {
  ContextPolicyDecision,
  ContextPolicyInput,
  PolicyAction,
} from './policy-compiler.ts'
export {
  classifyPressureRegime,
  frozenCheckpointCount,
  leafMarginalReclaim,
  pressureBreakdown,
  summarizePressureHistory,
} from './pressure.ts'
export type {
  LeafMarginalReclaim,
  PressureBreakdown,
  PressureHistory,
  PressureRegime,
  PressureSample,
} from './pressure.ts'
export { headroomDominates, triggerBreakdown, triggerBreakdownToText } from './trigger.ts'
export type { BindingConstraint, TriggerBreakdown } from './trigger.ts'
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
export type { AuthorityDomain, AuthoritativeEventKind } from './authority.ts'
export { createAnchorService, hostAdmitsPluginEvents } from './anchor-service.ts'
export type { AnchorDraft, AnchorService, AnchorServiceOptions } from './anchor-service.ts'
export {
  encodeCheckpointMarker,
  parseCheckpointMarker,
  normalizeCheckpointRef,
  displayCheckpointRef,
  hasCheckpointMarker,
} from './checkpoint-marker.ts'
export type { EfCheckpointMarker } from './checkpoint-marker.ts'
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
