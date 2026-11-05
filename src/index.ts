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
export { efOwnedConfigKeys, stripEfConfigKeys } from './policy.ts'
export {
  FRAMING_FALLBACK_TOKENS,
  ROOT_REBASE_COOLDOWN,
  admitLeafEconomically,
  evaluateEconomicRebase,
  rootRebaseAdvice,
} from './fold-economics.ts'
export type { LeafAdmissionVerdict } from './fold-economics.ts'
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
  WorkingSetMode,
} from './policy.ts'
export { assessWorkingSet, describeWorkingSet } from './working-set.ts'
export type {
  AssessWorkingSetOptions,
  ReclaimBasis,
  WorkingSetBasis,
  WorkingSetPressure,
} from './working-set.ts'
export {
  DEFAULT_DEMAND_WINDOW_EVENTS,
  assessThermalResidency,
  describeThermal,
  residencyCounts,
} from './thermal.ts'
export type {
  AssessThermalOptions,
  Residency,
  ResidencyVerdict,
  ThermalReport,
  ThermalUnavailable,
} from './thermal.ts'
export { decideShadowFolding, describeShadowDecision, shadowProfileId } from './shadow-policy.ts'
export type { ShadowFoldingDecision, ShadowPolicyOptions } from './shadow-policy.ts'
export { observeWorkingSet } from './working-set-observer.ts'
export type { ObserveWorkingSetOptions, WorkingSetObservation } from './working-set-observer.ts'
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
export {
  renderAnchorLine,
  renderFailureLine,
  renderStructuredCheckpoint,
  renderTemporalCheckpoint,
} from './renderer.ts'
export type { CheckpointPresentation, SemanticCheckpointInput } from './renderer.ts'
export {
  FileSemanticJournal,
  NullSemanticJournal,
  committedDeltaIds,
  packetIdOf,
} from './semantic/journal.ts'
export type { SemanticCommit, SemanticCommitRecord, SemanticJournal } from './semantic/journal.ts'
export { anchorIdsInLog, changedAnchors, planCommits } from './semantic/reconcile.ts'
export type { CommitPlan, PlanCommitsOptions } from './semantic/reconcile.ts'
export {
  DEFAULT_MAX_DELTAS,
  MAX_STATEMENT_CHARS,
  MAX_SUBJECT_CHARS,
  SEMANTIC_NAMESPACE,
  anchorIdOf,
  semanticStateKey,
  validateDeltas,
} from './semantic/validate.ts'
export type { ValidateDeltasOptions, ValidationResult } from './semantic/validate.ts'
export { citableMessages, messageText, resolveEvidence, resolveQuote } from './semantic/evidence.ts'
export type { CitableMessage, QuoteResolution } from './semantic/evidence.ts'
export {
  SEMANTIC_MAX_TOKENS,
  SEMANTIC_WRITER_INSTRUCTION,
  parseWriterOutput,
} from './semantic/writer.ts'
export type { WriterOutput } from './semantic/writer.ts'
export {
  DEFAULT_WORKING_SET_TOKENS,
  compileWorkingSet,
  describeWorkingSetCompilation,
} from './semantic/working-set-compiler.ts'
export type {
  CompileWorkingSetOptions,
  CompiledWorkingSet,
  WorkingSetEstimateBasis,
} from './semantic/working-set-compiler.ts'
export {
  EPISTEMIC_STATUSES,
  SEMANTIC_KINDS,
  SEMANTIC_SCHEMA_VERSION,
} from './semantic/types.ts'
export type {
  AcceptedDelta,
  EpistemicStatus,
  EvidenceRef,
  JournalRecord,
  ProposedDelta,
  ProposedEvidence,
  ReconciliationReport,
  SemanticDiagnostics,
  SemanticHealth,
  SemanticKind,
  SemanticLifecycle,
  SemanticMode,
  SemanticPacket,
  SemanticRefusal,
  SemanticRefusalReason,
  SemanticResidency,
  SemanticScope,
} from './semantic/types.ts'
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
