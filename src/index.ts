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
} from './policy/fold-economics.ts'
export type { LeafAdmissionVerdict } from './policy/fold-economics.ts'
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
} from './policy/economics-profile.ts'
export type {
  ContextEconomicsProfile,
  CostBreakdown,
  ObservedUsage,
  PolicyRegime,
  PricingTier,
} from './policy/economics-profile.ts'
export { compileContextPolicy } from './policy/policy-compiler.ts'
export type {
  ContextPolicyDecision,
  ContextPolicyInput,
  PolicyAction,
} from './policy/policy-compiler.ts'
export {
  classifyPressureRegime,
  frozenCheckpointCount,
  leafMarginalReclaim,
  pressureBreakdown,
  summarizePressureHistory,
} from './policy/pressure.ts'
export type {
  LeafMarginalReclaim,
  PressureBreakdown,
  PressureHistory,
  PressureRegime,
  PressureSample,
} from './policy/pressure.ts'
export { headroomDominates, triggerBreakdown, triggerBreakdownToText } from './policy/trigger.ts'
export type { BindingConstraint, TriggerBreakdown } from './policy/trigger.ts'
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
export { renderStructuredCheckpoint, renderTemporalCheckpoint } from './checkpoint/renderer.ts'
export type { SemanticCheckpointInput } from './checkpoint/renderer.ts'

// ---- Semantic Continuity v1 ------------------------------------------------
export {
  EF_PLUGIN_RECORD_TYPES,
  appendEfEvent,
  appendPluginEvent,
  efPluginRecordOf,
  pluginEventTransport,
} from './state/plugin-events.ts'
export type {
  EfPluginRecord,
  EfPluginRecordKind,
  PluginEventApi,
  PluginEventTransport,
} from './state/plugin-events.ts'
export {
  LEGACY_SEMANTIC_RECORD_VERSION,
  LEGACY_SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION,
} from './semantic/types.ts'
export type {
  AcceptedDelta,
  EpistemicStatus,
  PacketStatus,
  ProposedDelta,
  ReconciliationReport,
  SemanticAuthority,
  SemanticDiagnostics,
  SemanticHealth,
  SemanticKind,
  SemanticLifecycle,
  SemanticMode,
  SemanticPacket,
  SemanticReceipt,
  SemanticRefusal,
  SemanticRefusalReason,
  SemanticResidency,
  SemanticWorkingSetReport,
} from './semantic/types.ts'
export { parseWriterOutput, SEMANTIC_MAX_TOKENS, SEMANTIC_WRITER_INSTRUCTION } from './semantic/writer.ts'
export type { WriterOutput } from './semantic/writer.ts'
export { describeWriterObservation, observeWriter } from './semantic/observation.ts'
export type {
  ObserveWriterInput,
  RefusalCounts,
  SemanticRuntimeIntegrity,
  WriterCallOutcome,
  WriterObservation,
  WriterProtocolOutcome,
} from './semantic/observation.ts'
export { citableMessages, messageDigestOf, messageText, resolveEvidence, resolveQuote } from './semantic/evidence.ts'
export type { CitableMessage, QuoteResolution } from './semantic/evidence.ts'
export { anchorIdOf, semanticStateKey, validateDeltas } from './semantic/validate.ts'
export type { ValidateDeltasOptions, ValidationResult } from './semantic/validate.ts'
export { applyOps, planCommit } from './semantic/plan.ts'
export type { CommitPlan, PlannedDelta, PlanCommitOptions, ResolvedSupersede } from './semantic/plan.ts'
export {
  FileSemanticJournal,
  NullSemanticJournal,
  comparePackets,
  isLegacySemanticPacket,
  isSemanticPacket,
  isSemanticReceipt,
  opsDigestOf,
  packetIdOf,
  packetStatusOf,
} from './semantic/journal.ts'
export type { JournalIssue, JournalRead, JournalReadState, SemanticJournal } from './semantic/journal.ts'
export {
  ANCHOR_KINDS,
  ANCHOR_LIFECYCLES,
  AUTHORITY_DOMAINS,
  FAILURE_STATES,
  isAnchorOp,
  validateOps,
} from './semantic/ops.ts'
export type { OpsValidation, OpsValidationFailure } from './semantic/ops.ts'
export {
  packetIdentityProblem,
  receiptBindingProblem,
  sameFoldProof,
  validateSemanticCommit,
} from './semantic/integrity.ts'
export type {
  SemanticCommitValidation,
  SemanticIntegrityFailure,
  ValidateSemanticCommitOptions,
  ValidatedSemanticCommit,
} from './semantic/integrity.ts'
export { blockedNotice, mayCommitSemantics } from './semantic/admission.ts'
export type { ContinuityAdmission } from './semantic/admission.ts'
export { classifyPacket, healthOf, summaryTextOf } from './semantic/commit.ts'
export type { ClassifyPacketOptions, PacketCommitState } from './semantic/commit.ts'
export { proveFoldCommit } from './semantic/proof.ts'
export type {
  FoldAbortReason,
  FoldProofOptions,
  FoldProofResult,
  FoldProofSubject,
  HistoricalFoldProof,
} from './semantic/proof.ts'
export { replayWithSemanticCommits } from './semantic/replay.ts'
export type { SemanticCommit, SemanticReplay, SemanticReplayOptions } from './semantic/replay.ts'
export {
  projectSemanticOps,
  projectSemanticRecords,
  semanticRecordOf,
  semanticRecordPayloadOf,
  semanticRecordsIn,
} from './semantic/record.ts'
export type { SemanticRecordPayload } from './semantic/record.ts'
export { changedAnchors, changedOverflowLine, MAX_CHANGED_ANCHORS } from './semantic/changes.ts'
export type { ChangedSelection } from './semantic/changes.ts'
export {
  DEFAULT_CHECKPOINT_TOKENS,
  DEFAULT_WORKING_SET_TOKENS,
  compileWorkingSet,
  describeCheckpointCapacity,
  describeWorkingSetCompilation,
  measureCheckpointCapacity,
  residencyOf,
} from './semantic/working-set-compiler.ts'
export type {
  CheckpointCapacity,
  CompileWorkingSetOptions,
  CompiledWorkingSet,
  MeasureCheckpointOptions,
  WorkingSetEstimateBasis,
} from './semantic/working-set-compiler.ts'
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
