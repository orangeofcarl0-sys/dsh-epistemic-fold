/**
 * Epistemic Fold: a contract-preserving context runtime for DeepSeek Harness.
 * Public surface: engine, policy face, candidate registry, bundle store,
 * compiler, frontier/leaf/root policies, deterministic state + projection,
 * structured renderer, bounded recall tools.
 *
 * @module dsh-epistemic-fold
 */

export { EpistemicFoldEngine, default } from './fold/engine.ts'
export type { EpistemicFoldOptions } from './fold/engine.ts'
export { efOwnedConfigKeys, stripEfConfigKeys } from './config/policy.ts'
export {
  FRAMING_FALLBACK_TOKENS,
  ROOT_REBASE_COOLDOWN,
  admitLeafEconomically,
  evaluateEconomicRebase,
  rootRebaseAdvice,
} from './fold-economics.ts'
export type { LeafAdmissionVerdict } from './fold-economics.ts'
export { createFoldCandidate, FoldCandidateRegistry } from './fold/candidate.ts'
export { FileBundleStore } from './checkpoint/bundle-store.ts'
export {
  buildBundle,
  frameCheckpoint,
  renderFallbackCheckpoint,
  renderSemanticCheckpoint,
  splitSummarizationInput,
} from './checkpoint/compiler.ts'
export type { SplitSummarizationInput } from './checkpoint/compiler.ts'
export { canonicalHash, canonicalJson, sha256Hex } from './checkpoint/hash.ts'
export {
  compareCheckpointRecencyDescending,
  recall,
  search,
  searchWithDiagnosis,
  sourceRangeOf,
  DETAIL_INVENTORY_LINES,
  DETAIL_PAGE_CHARS,
  EXACT_PAGE_LIMIT,
  SEARCH_BROWSE_CANDIDATES,
} from './recall/recall.ts'
export type {
  BrowseCandidate,
  RecallDepth,
  RecallDescriptorView,
  RecallInventoryEntry,
  RecallResult,
  SearchConfidence,
  SearchDiagnosis,
  SearchHit,
  SearchMatchKind,
  SearchOutcome,
  SourceRange,
} from './recall/recall.ts'
export { INVENTORY_EXCERPT_CHARS, INVENTORY_LINES, inventoryEntriesOf, inventoryOf } from './checkpoint/inventory.ts'
export type { InventoryEntry } from './checkpoint/inventory.ts'
export { resolveEfConfig, resolveEfCompactSpec, DEFAULT_RETAIN_RATIO } from './config/policy.ts'
export type {
  EfCompactSpec,
  EpistemicFoldConfig,
  LeafAdmissionMode,
  ResolvedEpistemicFoldConfig,
} from './config/policy.ts'
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
} from './config/preset.ts'
export type {
  FoldModeName,
  PresetOverride,
  TierDefinition,
  TierEvidenceStatus,
  TierModeName,
  TierSummary,
} from './config/preset.ts'
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
export { registerRecallTools } from './recall/tools.ts'
export {
  registerEpistemicFoldProjection,
  currentFoldState,
  epistemicFoldProjection,
  EF_CURRENT_STATE_KEY,
} from './state/projection.ts'
export {
  authorityLossRate,
  emptyCurrentState,
  reduceEvent,
  stateKeyText,
  stateStalenessRate,
} from './state/state.ts'
export type {
  Anchor,
  AnchorKind,
  AnchorLifecycle,
  EfAnchorEventData,
  EventRef,
  FailureState,
  FoldCurrentState,
  StateKey,
} from './state/state.ts'
export { canVerify, groundableDomains, isAuthorityGrounded } from './state/authority.ts'
export type { AuthorityDomain, AuthoritativeEventKind } from './state/authority.ts'
export { createAnchorService, hostAdmitsPluginEvents } from './state/anchor-service.ts'
export type { AnchorDraft, AnchorService, AnchorServiceOptions } from './state/anchor-service.ts'
export {
  encodeCheckpointMarker,
  parseCheckpointMarker,
  normalizeCheckpointRef,
  displayCheckpointRef,
  hasCheckpointMarker,
} from './checkpoint/checkpoint-marker.ts'
export type { EfCheckpointMarker } from './checkpoint/checkpoint-marker.ts'
export { renderStructuredCheckpoint } from './checkpoint/renderer.ts'
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
