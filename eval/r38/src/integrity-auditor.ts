/**
 * R38-M0 WP2: the read-only cross-coordinate semantic integrity auditor.
 *
 * ## What it may and may not do
 *
 * This module reads committed packets and the projected state. It NEVER writes
 * a journal, retires an anchor, or proposes a repair. Conflict detection must
 * not acquire write authority: a lexical overlap is a reason to look, not a
 * reason to revoke a user's constraint.
 *
 * ## Deterministic before semantic
 *
 * Every finding is derivable from structured data plus a fixed text rule:
 *
 *   blocking          provable from ids, ops, digests or authority ranks
 *   requires-review   a real candidate that needs a human or model decision
 *   informational     context, not a defect
 *
 * The two text rules are deliberately narrow:
 *
 *  1. a `rejected-approach` whose `rulesOut` phrase appears in an active
 *     decision/constraint in the same scope (stale negative knowledge);
 *  2. two active anchors in the same scope with opposite polarity and a shared
 *     subject token (conflicting values).
 *
 * Two unrelated facts that share a keyword produce NO finding: rule 2 requires
 * opposite polarity, rule 1 requires an explicit `rulesOut` phrase. "Unknown"
 * is never reported as "consistent".
 *
 * @module eval/r38/src/integrity-auditor
 */

import type { Anchor, AnchorScope, FoldCurrentState } from '../../../src/state/state.ts'
import { stateKeyText } from '../../../src/state/state.ts'
import type { SemanticPacket, AcceptedDelta } from '../../../src/semantic/types.ts'
import { anchorIdOf } from '../../../src/semantic/validate.ts'
import { mayRetire } from '../../../src/semantic/retirement.ts'
import { sameScope } from '../../../src/semantic/plan.ts'

/** Three levels, not a score. A blocking finding is not averaged away. */
export type IntegritySeverity = 'blocking' | 'requires-review' | 'informational'

/** One audited packet with the state it resolved against. */
export interface AuditedPacket {
  readonly packet: SemanticPacket
  /** Projected state BEFORE this packet's operations. */
  readonly stateBefore: FoldCurrentState
}

/** Options for {@link auditSemanticIntegrity}. */
export interface AuditInput {
  readonly sessionId: string
  /** Projected state AFTER every packet. */
  readonly state: FoldCurrentState
  readonly packets: readonly AuditedPacket[]
  /** Seqs present in the session log; when provided, source refs are checked. */
  readonly sourceSeqs?: ReadonlySet<number>
  /** Only compare anchors inside this scope. Absent = compare every scope. */
  readonly scope?: AnchorScope
  /** Integrity problems already found by `validateSemanticCommit`. */
  readonly commitProblems?: readonly string[]
}

/** One finding. `anchorIds` are always the anchors the reader must inspect. */
export interface IntegrityFinding {
  readonly code: string
  readonly severity: IntegritySeverity
  readonly anchorIds: readonly string[]
  readonly detail: string
  readonly evidence?: Readonly<Record<string, unknown>>
}

/** The audit result. */
export interface IntegrityAudit {
  readonly sessionId: string
  readonly anchors: number
  readonly activeAnchors: number
  readonly relations: number
  readonly findings: readonly IntegrityFinding[]
  readonly counts: Readonly<Record<IntegritySeverity, number>>
}

/** One relation as the writer declared it, independent of whether it applied. */
export interface RelationRecord {
  readonly anchorId: string
  readonly deltaId: string
  readonly packetId: string
  readonly kind: string
  readonly authority: string
  readonly statement: string
  readonly scope?: AnchorScope
  readonly stateKeyText: string
  readonly lifecycle: string
  readonly supersedes: readonly string[]
  readonly dependsOn: readonly string[]
  readonly rulesOut: readonly string[]
  readonly sourceSeqs: readonly number[]
}

/** Words that carry no subject and would make every pair look related. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'are', 'was', 'were',
  'use', 'using', 'should', 'must', 'will', 'can', 'may', 'have', 'has', 'had', 'but', 'its',
  'our', 'their', 'than', 'then', 'when', 'where', 'which', 'while', 'about', 'after', 'before',
  'now', 'only', 'also', 'still', 'just', 'any', 'all', 'one', 'two', 'per', 'via',
])

/** Opposing pairs. A conflict needs one side of a pair on each anchor. */
const POLARITY_PAIRS: readonly (readonly [string, string])[] = [
  ['use', 'avoid'],
  ['enable', 'disable'],
  ['approve', 'reject'],
  ['allow', 'forbid'],
  ['keep', 'remove'],
  ['required', 'optional'],
  ['accept', 'decline'],
  ['include', 'exclude'],
]

/** Lowercase, collapse whitespace, strip surrounding punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').replace(/^[^a-z0-9\u4e00-\u9fff]+|[^a-z0-9\u4e00-\u9fff]+$/gu, '')
}

/** Every word, before stopword filtering. Polarity markers are often stopwords. */
function words(text: string): Set<string> {
  const matches = normalize(text).match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? []
  return new Set(matches)
}

/** Subject tokens, stopwords removed. */
function subjectTokens(text: string): Set<string> {
  const tokens = words(text)
  return new Set([...tokens].filter(word => !STOPWORDS.has(word)))
}

/** Which side of a polarity pair a text takes, if any. */
function polarity(text: string): 'positive' | 'negative' | undefined {
  const tokens = words(text)
  for (const [positive, negative] of POLARITY_PAIRS) {
    const hasPositive = tokens.has(positive)
    const hasNegative = tokens.has(negative)
    if (hasPositive && !hasNegative) return 'positive'
    if (hasNegative && !hasPositive) return 'negative'
  }
  return undefined
}

/** Whether two sets share at least `minimum` tokens. */
function overlap(left: Set<string>, right: Set<string>, minimum = 1): string[] {
  const shared: string[] = []
  for (const token of left) if (right.has(token)) shared.push(token)
  return shared.length >= minimum ? shared : []
}

/** Every anchor in the projected state, once. */
function allAnchors(state: FoldCurrentState): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  const push = (anchor: Anchor | undefined): void => {
    if (anchor !== undefined && !byId.has(anchor.id)) byId.set(anchor.id, anchor)
  }
  push(state.objective)
  for (const face of [state.constraints, state.stateHeads, state.openFailures, state.openObligations, state.decisions, state.evidence]) {
    for (const anchor of Object.values(face)) push(anchor)
  }
  return [...byId.values()]
}

/** The statement a delta contributes, before any rendering. */
function statementOf(delta: AcceptedDelta): string {
  return delta.statement
}

/** Build the relation index from committed packets. */
export function relationIndex(packets: readonly AuditedPacket[]): readonly RelationRecord[] {
  const records: RelationRecord[] = []
  for (const entry of packets) {
    for (const delta of entry.packet.accepted) {
      if (delta.stateKey === undefined) continue
      records.push({
        anchorId: anchorIdOf(delta.deltaId),
        deltaId: delta.deltaId,
        packetId: entry.packet.packetId,
        kind: delta.kind,
        authority: delta.authority,
        statement: statementOf(delta),
        ...(delta.scope === undefined ? {} : { scope: delta.scope }),
        stateKeyText: stateKeyText(delta.stateKey),
        lifecycle: 'declared',
        supersedes: delta.supersedes,
        dependsOn: delta.dependsOn,
        rulesOut: delta.rulesOut,
        sourceSeqs: delta.evidence.map(ref => ref.seq),
      })
    }
  }
  return records
}

/** Resolve one relation target against the final state and the index. */
function targetExists(
  target: string,
  scope: AnchorScope | undefined,
  anchors: readonly Anchor[],
  records: readonly RelationRecord[],
): boolean {
  if (records.some(record => record.anchorId === target || record.stateKeyText === target)) return true
  return anchors.some(anchor =>
    anchor.id === target
    || (anchor.stateKey !== undefined && stateKeyText(anchor.stateKey) === target)
    || (anchor.stateKey?.namespace === 'semantic'
      && anchor.stateKey.property === target
      && sameScope(anchor.scope, scope)))
}

/** Whether a supersede target resolves against one state (historical packets). */
function resolvesInState(
  target: string,
  delta: AcceptedDelta,
  state: FoldCurrentState,
): boolean {
  if (target === 'previous') return true
  const anchors = allAnchors(state)
  return anchors.some(anchor =>
    anchor.id === target
    || (anchor.stateKey !== undefined && stateKeyText(anchor.stateKey) === target)
    || (anchor.stateKey?.namespace === 'semantic'
      && anchor.stateKey.property === target
      && sameScope(anchor.scope, delta.scope)))
    || Object.values(state.superseded).some(anchor => anchor.id === target)
}

/** Audit one session's committed semantic state. */
export function auditSemanticIntegrity(input: AuditInput): IntegrityAudit {
  const findings: IntegrityFinding[] = []
  const anchors = allAnchors(input.state)
  const records = relationIndex(input.packets)
  const inScope = (anchor: Anchor): boolean =>
    input.scope === undefined || sameScope(anchor.scope, input.scope)
  const scoped = anchors.filter(inScope)
  const active = scoped.filter(anchor => anchor.lifecycle === 'active')

  // 1. Integrity problems the commit gate already proved.
  for (const problem of input.commitProblems ?? []) {
    findings.push({
      code: 'commit-integrity',
      severity: 'blocking',
      anchorIds: [],
      detail: problem,
    })
  }

  // 2. A committed retire op whose declaring delta was never authorized.
  for (const entry of input.packets) {
    for (const op of entry.packet.ops) {
      if (op.op !== 'retire' || op.anchorId === undefined) continue
      const target = allAnchors(entry.stateBefore).find(anchor => anchor.id === op.anchorId)
      if (target === undefined) continue
      const declaring = entry.packet.accepted.filter(delta =>
        delta.supersedes.some(name =>
          name === target.id
          || (target.stateKey !== undefined && stateKeyText(target.stateKey) === name)
          || (target.stateKey?.namespace === 'semantic'
            && target.stateKey.property === name
            && sameScope(target.scope, delta.scope))))
      if (declaring.length === 0) {
        findings.push({
          code: 'orphaned-retirement',
          severity: 'informational',
          anchorIds: [target.id],
          detail: `packet ${entry.packet.packetId.slice(0, 12)} retired an anchor no accepted delta names`,
          evidence: { packetId: entry.packet.packetId, anchorId: target.id },
        })
        continue
      }
      const authorized = declaring.some(delta => mayRetire({
        declaring: delta.authority,
        target: target.authority,
        sameScope: sameScope(target.scope, delta.scope),
      }).allowed)
      if (!authorized) {
        findings.push({
          code: 'unauthorized-retirement',
          severity: 'blocking',
          anchorIds: [target.id],
          detail: `a ${declaring.map(delta => delta.authority).join('/')} claim retired a ${target.authority} anchor`,
          evidence: {
            packetId: entry.packet.packetId,
            anchorId: target.id,
            declaringDeltaIds: declaring.map(delta => delta.deltaId),
          },
        })
      }
    }
  }

  // 3. Relations the planner could not apply, as recorded by the packet.
  for (const entry of input.packets) {
    const audit = entry.packet.retirement
    if (audit === undefined) {
      // A packet written before the retirement audit existed. Its `accepted`
      // deltas still name targets; an unresolved one is reported, because the
      // ops array cannot distinguish "no retirement asked for" from "retirement
      // silently dropped".
      for (const delta of entry.packet.accepted) {
        for (const target of delta.supersedes) {
          if (resolvesInState(target, delta, entry.stateBefore)) continue
          findings.push({
            code: 'unresolved-supersession',
            severity: 'requires-review',
            anchorIds: [],
            detail: `delta ${delta.deltaId.slice(0, 12)} names "${target}", which did not resolve at commit time`,
            evidence: { packetId: entry.packet.packetId, target },
          })
        }
      }
      continue
    }
    for (const row of audit.withheld) {
      findings.push({
        code: 'unresolved-supersession',
        severity: 'requires-review',
        anchorIds: [],
        detail: `delta ${row.deltaId.slice(0, 12)} was withheld: ${row.reason} (${row.targets.join(', ')})`,
        evidence: { packetId: entry.packet.packetId, ...row },
      })
    }
    for (const row of audit.refused) {
      findings.push({
        code: 'refused-retirement',
        severity: 'requires-review',
        anchorIds: row.anchorId === undefined ? [] : [row.anchorId],
        detail: `delta ${row.deltaId.slice(0, 12)} may not retire ${row.target}: ${row.reason}`,
        evidence: { packetId: entry.packet.packetId, ...row },
      })
    }
  }

  // 4. A declared dependency that no longer resolves.
  for (const record of records) {
    for (const dependency of record.dependsOn) {
      if (!targetExists(dependency, record.scope, anchors, records)) {
        findings.push({
          code: 'unresolved-dependency',
          severity: 'requires-review',
          anchorIds: [record.anchorId],
          detail: `${record.kind} ${record.anchorId.slice(0, 12)} depends on "${dependency}", which does not resolve`,
          evidence: { packetId: record.packetId, dependency },
        })
      }
    }
  }

  // 5. An anchor citing an event the log does not contain.
  if (input.sourceSeqs !== undefined) {
    for (const anchor of scoped) {
      const missing = anchor.sourceRefs
        .map(ref => Number(ref.seq))
        .filter(seq => !input.sourceSeqs!.has(seq))
      if (missing.length > 0) {
        findings.push({
          code: 'missing-source-evidence',
          severity: 'blocking',
          anchorIds: [anchor.id],
          detail: `anchor cites ${missing.length} seq(s) absent from the log`,
          evidence: { missing },
        })
      }
    }
  }

  // 6. Stale negative knowledge: a rejected approach whose ruled-out phrase is
  //    now used by an active value in the same scope.
  for (const anchor of active) {
    const record = records.find(row => row.anchorId === anchor.id)
    if (record === undefined || record.kind !== 'rejected-approach') continue
    for (const phrase of record.rulesOut) {
      const needle = normalize(phrase)
      if (needle.length < 3) continue
      for (const other of active) {
        if (other.id === anchor.id) continue
        if (!sameScope(anchor.scope, other.scope)) continue
        if (typeof other.value !== 'string') continue
        if (!normalize(other.value).includes(needle)) continue
        findings.push({
          code: 'stale-negative-knowledge',
          severity: 'requires-review',
          anchorIds: [anchor.id, other.id],
          detail: `"${phrase}" is ruled out by ${anchor.id.slice(0, 12)} but used by ${other.id.slice(0, 12)}`,
          evidence: { ruledOut: phrase, rejectedAnchorId: anchor.id, activeAnchorId: other.id },
        })
      }
    }
  }

  // 7. Two active anchors in the same scope with opposite polarity and a shared
  //    subject token. Different scopes are reported as a candidate only.
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left]!
      const b = active[right]!
      if (a.stateKey !== undefined && b.stateKey !== undefined
        && stateKeyText(a.stateKey) === stateKeyText(b.stateKey)) continue
      if (typeof a.value !== 'string' || typeof b.value !== 'string') continue
      const polarityA = polarity(a.value)
      const polarityB = polarity(b.value)
      if (polarityA === undefined || polarityB === undefined || polarityA === polarityB) continue
      const shared = overlap(subjectTokens(a.value), subjectTokens(b.value), 1)
      if (shared.length === 0) continue
      const same = sameScope(a.scope, b.scope)
      findings.push({
        code: same ? 'conflicting-active-anchors' : 'cross-scope-conflict-candidate',
        severity: same ? 'requires-review' : 'informational',
        anchorIds: [a.id, b.id],
        detail: same
          ? `opposite polarity at a shared subject (${shared.join(', ')})`
          : `opposite polarity across scopes; not necessarily a conflict`,
        evidence: { shared, left: a.value, right: b.value },
      })
    }
  }

  const counts: Record<IntegritySeverity, number> = {
    blocking: findings.filter(row => row.severity === 'blocking').length,
    'requires-review': findings.filter(row => row.severity === 'requires-review').length,
    informational: findings.filter(row => row.severity === 'informational').length,
  }
  return {
    sessionId: input.sessionId,
    anchors: anchors.length,
    activeAnchors: active.length,
    relations: records.reduce((sum, row) =>
      sum + row.supersedes.length + row.dependsOn.length + row.rulesOut.length, 0),
    findings,
    counts,
  }
}
