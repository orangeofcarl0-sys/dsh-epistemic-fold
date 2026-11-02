#!/usr/bin/env node
/**
 * R36-A: close the R35 evidence from the real traces, not from its summaries.
 *
 * The R35 write-up reported 17 writer calls and 16 scoreable rows, but the
 * artifact itself did not contain a per-attempt table, and the six "protocol
 * malformed" rows were one aggregate. This script rereads every writer-only
 * report and raw output and publishes:
 *
 *   writer-attempts   one row per provider call, including the F1 row the
 *                     pre-fix runner lost
 *   protocol class    parsed, absent envelope, bare array, bare object,
 *                     invalid JSON, invalid schema, truncation, other
 *   Fact x Attempt    L0 raw mention -> L1 structured proposal -> L2 accepted
 *                     -> L3 durable commit -> L4 checkpoint visibility
 *   handoff exposure  refused claims that still appear in prose, and whether
 *                     they ever became machine state
 *
 * No model is called. The R35 run directories are read-only; this script writes
 * only under `eval/r36/evidence/r35/`.
 *
 * @module eval/r36/audit-r35
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDataset } from '../r33/src/dataset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, 'evidence', 'r35')
const REPORTS = join(EVIDENCE, 'reports')
const RAW = join(EVIDENCE, 'raw-writer')
const OUT = join(EVIDENCE, 'writer-audit.json')

const writerModule = await import('../../lib/semantic/writer.js')
  .catch(() => import('../../src/semantic/writer.ts'))
const { parseWriterOutput } = writerModule

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'for', 'with',
  'as', 'at', 'by', 'from', 'it', 'its', 'we', 'you', 'they', 'he', 'she', 'i', 'not', 'no',
  'must', 'should', 'will', 'would', 'can', 'could', 'may', 'might', 'has', 'have', 'had',
  'do', 'does', 'did', 'so', 'because', 'when', 'where', 'which', 'what', 'who', 'how',
])

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter(token => token.length > 3 && !STOPWORDS.has(token)))
}

/** How much of `left`'s vocabulary occurs in `right` (0..1). */
function containment(left, right) {
  const leftTokens = tokens(left)
  const rightTokens = tokens(right)
  if (leftTokens.size === 0) return 0
  let matched = 0
  for (const token of leftTokens) if (rightTokens.has(token)) matched += 1
  return matched / leftTokens.size
}

function similar(left, right) {
  return normalize(left) === normalize(right)
    || containment(left, right) >= 0.7
    || containment(right, left) >= 0.7
}

/** A bounded splitter for a sequence of concatenated top-level JSON values. */
function parseJsonSequence(text) {
  const values = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index])) index += 1
    if (index >= text.length) break
    const open = text[index]
    if (open !== '{' && open !== '[') return undefined
    const stack = []
    let inString = false
    let escaped = false
    let end = -1
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const character = text[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') { inString = true; continue }
      if (character === '{' || character === '[') stack.push(character)
      else if (character === '}' || character === ']') {
        stack.pop()
        if (stack.length === 0) { end = cursor + 1; break }
      }
    }
    if (end === -1) return undefined
    try {
      values.push(JSON.parse(text.slice(index, end)))
    } catch {
      return undefined
    }
    index = end
  }
  return values.length === 0 ? undefined : values
}

/** Classify a non-parsed writer response from its actual text. */
function classifyProtocol(text, parse) {
  if (parse.deltaParse === 'parsed') {
    return { category: 'parsed', recoverableProposals: parse.proposed.length, detail: null }
  }
  if (text === null || text === undefined) {
    return { category: 'unknown', recoverableProposals: null, detail: 'raw output was lost by the pre-fix runner' }
  }
  const open = text.indexOf('<deltas>')
  const close = text.indexOf('</deltas>')
  if (open === -1) {
    return { category: 'absent-deltas-envelope', recoverableProposals: null, detail: 'the response has no <deltas> block' }
  }
  if (close === -1) {
    return { category: 'unclosed-deltas-envelope', recoverableProposals: null, detail: 'the <deltas> block never closes' }
  }
  const block = text.slice(open + '<deltas>'.length, close).trim()
  const unfenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/u.exec(block)?.[1]?.trim() ?? block
  if (unfenced.startsWith('[')) {
    try {
      const value = JSON.parse(unfenced)
      return {
        category: 'bare-json-array',
        recoverableProposals: Array.isArray(value) ? value.length : null,
        detail: 'the block is an array, not the required {"deltas":[...]} object',
      }
    } catch (error) {
      return {
        category: 'invalid-json-syntax',
        recoverableProposals: null,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (unfenced.startsWith('{')) {
    try {
      const value = JSON.parse(unfenced)
      return {
        category: 'invalid-top-level-schema',
        recoverableProposals: value !== null && typeof value === 'object' && Array.isArray(value.deltas)
          ? value.deltas.length
          : null,
        detail: 'the block parses as an object but is not the expected top-level schema',
      }
    } catch {
      const sequence = parseJsonSequence(unfenced)
      if (sequence !== undefined && sequence.every(value => value !== null && typeof value === 'object')) {
        return {
          category: 'bare-json-object',
          recoverableProposals: sequence.length,
          detail: `${sequence.length} concatenated top-level object(s), not one {"deltas":[...]} object`,
        }
      }
      return {
        category: 'invalid-json-syntax',
        recoverableProposals: null,
        detail: 'the block does not parse as JSON',
      }
    }
  }
  return { category: 'other', recoverableProposals: null, detail: 'the block has no JSON value' }
}

function deltaMatch(delta, fact) {
  if (delta === null || typeof delta !== 'object') return undefined
  if (typeof delta.kind !== 'string') return undefined
  const family = kind => {
    if (kind === 'constraint' || kind === 'objective' || kind === 'obligation') return 'normative'
    if (kind === 'finding' || kind === 'failure') return 'empirical'
    return kind
  }
  const familyMatch = delta.kind !== fact.kind
    && family(delta.kind) === family(fact.kind)
    && family(fact.kind) !== fact.kind
  const kindMatches = delta.kind === fact.kind || familyMatch
  if (!kindMatches) return undefined
  const quotes = Array.isArray(delta.evidence)
    ? delta.evidence.map(entry => (entry !== null && typeof entry === 'object' ? entry.quote : undefined))
      .filter(quote => typeof quote === 'string')
    : []
  if (quotes.some(quote => quote.includes(fact.quote) || quote.includes(fact.visibleNeedle))) {
    return 'evidence-quote'
  }
  if (normalize(delta.statement).includes(normalize(fact.visibleNeedle))) return 'visible-needle'
  if (normalize(delta.subjectKey) === normalize(fact.subjectKey)) return 'subject-key'
  if (typeof delta.statement === 'string' && semanticStatementMatch(delta.statement, fact.statement)) {
    return 'statement'
  }
  return undefined
}

/**
 * A deliberately looser statement match for the FUNNEL only.
 *
 * The writer often paraphrases the gold ("Using fs.watch is rejected" vs
 * "Relying on fs.watch ... is rejected"). Exact equality would call a correct
 * capture lost. This is not the scorer: it asks whether the attempt carried the
 * fact at this level, and it requires both a kind-family match and at least two
 * shared content tokens.
 */
function semanticStatementMatch(left, right) {
  const leftTokens = tokens(left)
  const rightTokens = tokens(right)
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  if (shared < 2) return false
  return normalize(left) === normalize(right)
    || containment(left, right) >= 0.45
    || containment(right, left) >= 0.45
}

function rawMention(text, fact) {
  if (text === null) return { mentioned: null, basis: 'raw-output-lost' }
  if (text.includes(fact.quote)) return { mentioned: true, basis: 'quote' }
  if (text.toLowerCase().includes(fact.visibleNeedle.toLowerCase())) return { mentioned: true, basis: 'visible-needle' }
  if (containment(fact.statement, text) >= 0.6) return { mentioned: true, basis: 'statement-vocabulary' }
  return { mentioned: false, basis: null }
}

async function rawTextFor(runId, caseId) {
  const path = join(RAW, runId, `${caseId}.raw.txt`)
  try {
    return { text: await readFile(path, 'utf8'), path: `evidence/r35/raw-writer/${runId}/${caseId}.raw.txt` }
  } catch {
    return { text: null, path: null }
  }
}

function reportDigest(raw) {
  return digest(raw)
}

function refusalReasons(writer) {
  return Array.isArray(writer?.refusalReasons) ? writer.refusalReasons : []
}

function quoteSources(quotes, transcript) {
  const roles = new Set()
  for (const quote of quotes) {
    if (typeof quote !== 'string') continue
    for (const entry of transcript) {
      if (typeof entry.text === 'string' && entry.text.includes(quote)) roles.add(entry.role)
    }
  }
  return [...roles].sort()
}

function exposureOf(refusal, writer, state, checkpoint, transcript) {
  const statement = typeof refusal.statement === 'string' ? refusal.statement : ''
  const handoff = typeof writer?.handoff === 'string' ? writer.handoff : ''
  const anchors = Array.isArray(state?.anchors) ? state.anchors : []
  if (statement.length === 0) {
    return {
      refusalReason: refusal.reason ?? null,
      kind: refusal.kind ?? null,
      statement: '',
      evidenceRoles: [],
      inHandoff: false,
      inCheckpoint: false,
      inMachineState: false,
      exposure: 'unresolved',
    }
  }
  const machine = anchors.some(anchor => similar(anchor, statement))
  const inCheckpoint = similar(checkpoint ?? '', statement)
  const inHandoff = similar(handoff, statement)
  const quotes = Array.isArray(refusal.evidence)
    ? refusal.evidence.map(entry => (entry !== null && typeof entry === 'object' ? entry.quote : undefined))
    : []
  return {
    refusalReason: refusal.reason ?? null,
    kind: refusal.kind ?? null,
    statement,
    evidenceRoles: quoteSources(quotes, transcript),
    inHandoff,
    inCheckpoint,
    inMachineState: machine,
    exposure: machine ? 'machine-state' : (inHandoff || inCheckpoint) ? 'narrative-only' : 'not-visible',
  }
}

async function attemptRows(report, caseById) {
  const rows = []
  const writerRows = report.rows.filter(row => row.arm === 'S')
  for (const row of writerRows) {
    const caseData = caseById.get(row.caseId)
    if (caseData === undefined) continue
    const writer = row.writer
    if (writer === undefined || writer === null) {
      rows.push({
        runId: report.runId,
        replicateId: row.replicateId ?? report.runId,
        caseId: row.caseId,
        gitSha: null,
        gitShaNote: 'R35 artifacts did not record the commit; see sourceCommitAtAudit',
        model: report.model,
        providerRoute: report.route?.baseUrlEnv ?? null,
        finishReason: null,
        finishReasonRecorded: false,
        writerCallStatus: 'lost-row',
        writerProviderCall: row.providerCalls ?? null,
        rawOutputDigest: null,
        reportRawOutputDigest: null,
        rawOutputChars: null,
        rawOutputSource: null,
        protocolStatus: 'unknown',
        protocolCategory: 'unknown',
        protocolDetail: 'the pre-fix runner lost this row after the fold guard threw',
        proposalCount: null,
        recoverableProposals: null,
        acceptedCount: null,
        refusedCount: null,
        refusalReasons: [],
        foldOutcome: row.failures?.fold?.[0]?.kind ?? 'harness-error',
        commitStatus: 'unknown-lost-row',
        checkpointDigest: row.checkpoint?.digest ?? null,
        stateDigest: null,
        observedTokens: row.cost ? {
          input: row.cost.observedInputTokens ?? null,
          output: row.cost.observedOutputTokens ?? null,
          cacheRead: row.cost.cacheReadTokens ?? null,
          cacheWrite: row.cost.cacheWriteTokens ?? null,
        } : null,
        writerObservedUsage: null,
        reservedTokens: row.cost ? {
          input: row.cost.reservedInputTokens ?? 0,
          output: row.cost.reservedOutputTokens ?? 0,
        } : null,
        httpAttempts: row.cost?.httpAttempts ?? null,
        rowLost: true,
        note: 'This provider call is in the ledger and the cost totals, but no raw output or commit survived the pre-fix runner.',
      })
      continue
    }
    const rawFile = await rawTextFor(report.runId, row.caseId)
    const text = rawFile.text ?? writer.rawOutput ?? null
    const parse = parseWriterOutput(text ?? '')
    const protocol = classifyProtocol(text, parse)
    rows.push({
      runId: report.runId,
      replicateId: row.replicateId ?? report.runId,
      caseId: row.caseId,
      gitSha: null,
      gitShaNote: 'R35 artifacts did not record the commit; see sourceCommitAtAudit',
      model: report.model,
      providerRoute: report.route?.baseUrlEnv ?? null,
      finishReason: null,
      finishReasonRecorded: false,
      writerCallStatus: writer.call ?? writer.callStatus ?? null,
      writerProviderCall: row.providerCalls ?? null,
      rawOutputDigest: rawFile.text === null ? writer.rawOutputDigest ?? null : digest(rawFile.text),
      reportRawOutputDigest: writer.rawOutputDigest ?? null,
      rawOutputChars: rawFile.text === null ? writer.rawOutputChars ?? null : rawFile.text.length,
      rawOutputSource: rawFile.path ?? (writer.rawOutput === null ? null : 'report-preview'),
      protocolStatus: parse.deltaParse,
      protocolCategory: protocol.category,
      protocolDetail: protocol.detail,
      proposalCount: parse.proposed.length,
      recoverableProposals: protocol.recoverableProposals,
      acceptedCount: writer.accepted ?? null,
      refusedCount: writer.refused ?? null,
      refusalReasons: refusalReasons(writer),
      foldOutcome: row.fold?.valid === true ? 'fold-committed' : (row.writer?.commitStatus === 'fold-refused' ? 'fold-refused' : 'fold-invalid'),
      commitStatus: writer.commitStatus ?? null,
      checkpointDigest: row.checkpoint?.digest ?? null,
      stateDigest: writer.stateDigest ?? null,
      observedTokens: {
        input: row.cost?.observedInputTokens ?? null,
        output: row.cost?.observedOutputTokens ?? null,
        cacheRead: row.cost?.cacheReadTokens ?? null,
        cacheWrite: row.cost?.cacheWriteTokens ?? null,
      },
      writerObservedUsage: writer.actualProviderUsage ?? null,
      reservedTokens: {
        input: row.cost?.reservedInputTokens ?? 0,
        output: row.cost?.reservedOutputTokens ?? 0,
      },
      httpAttempts: row.cost?.httpAttempts ?? null,
      rowLost: false,
      /// The raw model text is kept so a later parser ablation can replay it
      /// without a provider call.
      rawText: text,
      proposedDeltas: Array.isArray(writer.proposedDeltas) ? writer.proposedDeltas : [],
      acceptedDeltas: Array.isArray(writer.acceptedDeltas) ? writer.acceptedDeltas : [],
      refusedDeltas: Array.isArray(writer.refusedDeltas) ? writer.refusedDeltas : [],
    })
  }
  return rows
}

function factRows(attempt, caseData) {
  if (attempt.rowLost) {
    return caseData.gold.map(fact => ({
      factId: fact.factId,
      level0: null,
      level1: null,
      level2: null,
      level3: null,
      level4: null,
      unknown: true,
    }))
  }
  const proposed = attempt.proposedDeltas
  const accepted = attempt.acceptedDeltas
  const checkpoint = caseData.checkpointText ?? ''
  return caseData.gold.map(fact => {
    const mention = rawMention(attempt.rawText, fact)
    const proposalMatch = proposed.map(delta => deltaMatch(delta, fact)).find(Boolean)
    const acceptedMatch = accepted.map(delta => deltaMatch(delta, fact)).find(Boolean)
    const stateVisible = Array.isArray(caseData.stateAnchors)
      && caseData.stateAnchors.some(anchor => anchor.includes(fact.visibleNeedle))
    const checkpointVisible = checkpoint.includes(fact.visibleNeedle)
      || accepted.some(delta => deltaMatch(delta, fact) !== undefined
        && (checkpoint.includes(delta.statement) || (caseData.stateAnchors ?? []).some(anchor => anchor.includes(delta.statement))))
    return {
      factId: fact.factId,
      criticality: fact.criticality,
      current: fact.current,
      level0: mention.mentioned,
      level0Basis: mention.basis,
      level1: proposalMatch !== undefined,
      level1Basis: proposalMatch ?? null,
      level2: acceptedMatch !== undefined,
      level2Basis: acceptedMatch ?? null,
      level3: attempt.commitStatus === 'committed' && acceptedMatch !== undefined,
      level4: fact.current === true ? (checkpointVisible || stateVisible) : null,
      directVisibility: checkpointVisible || stateVisible,
    }
  })
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function mean(values) {
  const present = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length
}

async function main() {
  const { cases, datasetDigest, errors } = await loadDataset()
  if (errors.length > 0) throw new Error(`dataset errors: ${JSON.stringify(errors)}`)
  const caseById = new Map(cases.map(entry => [entry.id, entry]))
  const files = (await readdir(REPORTS)).filter(file => file.endsWith('.json')).sort()
  const reports = []
  for (const file of files) {
    const raw = await readFile(join(REPORTS, file), 'utf8')
    const report = JSON.parse(raw)
    reports.push({ file, raw, report })
  }

  const writerOnly = reports.filter(entry => entry.report.stage === 'writer-only')
  const attempts = []
  for (const { report } of writerOnly) {
    attempts.push(...await attemptRows(report, caseById))
  }

  const categories = {}
  for (const attempt of attempts) {
    categories[attempt.protocolCategory] = (categories[attempt.protocolCategory] ?? 0) + 1
  }
  const perCase = {}
  for (const attempt of attempts) {
    const bucket = perCase[attempt.caseId] ?? { attempts: 0, scoreable: 0, parsed: 0, categories: {} }
    bucket.attempts += 1
    if (!attempt.rowLost) bucket.scoreable += 1
    if (attempt.protocolCategory === 'parsed') bucket.parsed += 1
    bucket.categories[attempt.protocolCategory] = (bucket.categories[attempt.protocolCategory] ?? 0) + 1
    perCase[attempt.caseId] = bucket
  }

  // The fact funnel needs the checkpoint and anchors from the report row; they
  // are attached here rather than copied into every attempt row.
  const attemptByKey = new Map(attempts.map(attempt => [`${attempt.runId}|${attempt.caseId}`, attempt]))
  for (const { report } of writerOnly) {
    for (const row of report.rows.filter(entry => entry.arm === 'S')) {
      const attempt = attemptByKey.get(`${report.runId}|${row.caseId}`)
      if (attempt === undefined) continue
      const caseData = caseById.get(row.caseId)
      if (caseData === undefined) continue
      attempt.caseData = {
        gold: caseData.gold,
        checkpointText: row.checkpoint?.text ?? '',
        stateAnchors: row.state?.anchors ?? [],
        transcript: caseData.transcript,
      }
    }
  }
  const funnel = []
  for (const attempt of attempts) {
    const caseData = attempt.caseData
    if (caseData === undefined) continue
    const facts = factRows(attempt, caseData)
    const currentFacts = facts.filter(fact => fact.current === true)
    funnel.push({
      runId: attempt.runId,
      caseId: attempt.caseId,
      protocolCategory: attempt.protocolCategory,
      rowLost: attempt.rowLost,
      facts,
      rates: {
        rawRecall: rate(facts.filter(fact => fact.level0 === true).length, facts.length),
        proposalRecall: rate(facts.filter(fact => fact.level1 === true).length, facts.length),
        acceptedRecall: rate(facts.filter(fact => fact.level2 === true).length, facts.length),
        commitRecall: rate(facts.filter(fact => fact.level3 === true).length, facts.length),
        directVisibility: rate(currentFacts.filter(fact => fact.level4 === true).length, currentFacts.length),
      },
    })
  }

  const funnelByCase = {}
  for (const entry of funnel) {
    const bucket = funnelByCase[entry.caseId] ?? []
    bucket.push(entry)
    funnelByCase[entry.caseId] = bucket
  }
  const perCaseFunnel = {}
  for (const [caseId, entries] of Object.entries(funnelByCase)) {
    const scoreable = entries.filter(entry => !entry.rowLost)
    const meanOf = key => mean(scoreable.map(entry => entry.rates[key]))
    perCaseFunnel[caseId] = {
      attempts: entries.length,
      scoreable: scoreable.length,
      rawRecall: meanOf('rawRecall'),
      proposalRecall: meanOf('proposalRecall'),
      acceptedRecall: meanOf('acceptedRecall'),
      commitRecall: meanOf('commitRecall'),
      directVisibility: meanOf('directVisibility'),
      bestReplicateOnly: {
        rawRecall: Math.max(...scoreable.map(entry => entry.rates.rawRecall ?? 0), 0),
        proposalRecall: Math.max(...scoreable.map(entry => entry.rates.proposalRecall ?? 0), 0),
        acceptedRecall: Math.max(...scoreable.map(entry => entry.rates.acceptedRecall ?? 0), 0),
        commitRecall: Math.max(...scoreable.map(entry => entry.rates.commitRecall ?? 0), 0),
      },
    }
  }
  const overallFunnel = {
    attempts: funnel.length,
    scoreable: funnel.filter(entry => !entry.rowLost).length,
    rawRecall: mean(funnel.filter(entry => !entry.rowLost).map(entry => entry.rates.rawRecall)),
    proposalRecall: mean(funnel.filter(entry => !entry.rowLost).map(entry => entry.rates.proposalRecall)),
    acceptedRecall: mean(funnel.filter(entry => !entry.rowLost).map(entry => entry.rates.acceptedRecall)),
    commitRecall: mean(funnel.filter(entry => !entry.rowLost).map(entry => entry.rates.commitRecall)),
    directVisibility: mean(funnel.filter(entry => !entry.rowLost).map(entry => entry.rates.directVisibility)),
  }

  // Handoff exposure: every refused delta, whether it survived in prose, and
  // whether it ever became an anchor. Writer-only reports keep `refusedDeltas`
  // as index+reason only; the original proposal is recovered from the raw
  // response by index. Continuation traces carry the full writer object.
  let continuationRows = []
  try {
    const compact = JSON.parse(await readFile(join(EVIDENCE, 'continuation-writers.json'), 'utf8'))
    continuationRows = Array.isArray(compact.rows) ? compact.rows : []
  } catch {
    continuationRows = []
  }
  const continuationByKey = new Map(
    continuationRows.map(entry => [`${entry.runId}|${entry.caseId}|${entry.replicateId}`, entry]),
  )
  const exposure = []
  for (const { report } of reports) {
    for (const row of report.rows.filter(entry => entry.writer?.applicable === true && entry.writer?.oracle !== true)) {
      const caseData = caseById.get(row.caseId)
      if (caseData === undefined) continue
      const continuation = report.stage === 'continuation'
        ? continuationByKey.get(`${report.runId}|${row.caseId}|${row.replicateId}`)
        : undefined
      const writer = continuation?.writer ?? row.writer
      const state = continuation?.state ?? row.state
      const checkpoint = continuation?.checkpoint ?? row.checkpoint?.text ?? ''
      let rawText = continuation?.writerRaw ?? writer?.rawOutput ?? null
      if (rawText === null && report.stage === 'writer-only') {
        rawText = (await rawTextFor(report.runId, row.caseId)).text
      }
      const rawParse = rawText === null ? undefined : parseWriterOutput(rawText)
      const proposed = Array.isArray(writer?.proposedDeltas)
        ? writer.proposedDeltas
        : rawParse?.deltaParse === 'parsed'
          ? rawParse.proposed
          : []
      for (const refusal of writer?.refusedDeltas ?? []) {
        const original = Number.isInteger(refusal.index) ? proposed[refusal.index] : undefined
        const content = {
          ...(original ?? {}),
          ...refusal,
          statement: refusal.statement ?? original?.statement ?? null,
          kind: refusal.kind ?? original?.kind ?? null,
          evidence: refusal.evidence ?? original?.evidence ?? [],
        }
        const assessment = exposureOf(content, writer, state, checkpoint, caseData.transcript)
        const measurementValid = report.stage === 'continuation'
          ? row.valid !== false && !report.runId.includes('-r2')
          : row.valid !== false
        exposure.push({
          runId: report.runId,
          stage: report.stage,
          caseId: row.caseId,
          arm: row.arm,
          measurementValid,
          ...assessment,
          statementResolved: typeof assessment.statement === 'string' && assessment.statement.length > 0,
        })
      }
    }
  }
  const resolved = exposure.filter(entry => entry.statementResolved)
  const exposureTotals = {
    refusedDeltas: exposure.length,
    resolvedRefusals: resolved.length,
    unresolvedRefusals: exposure.length - resolved.length,
    machineState: resolved.filter(entry => entry.inMachineState).length,
    narrativeOnly: resolved.filter(entry => !entry.inMachineState && (entry.inHandoff || entry.inCheckpoint)).length,
    notVisible: resolved.filter(entry => !entry.inMachineState && !entry.inHandoff && !entry.inCheckpoint).length,
    authorityUngrounded: resolved.filter(entry => entry.refusalReason === 'authority-ungrounded').length,
    verificationUnscoped: resolved.filter(entry => entry.refusalReason === 'verification-unscoped').length,
    byReason: resolved.reduce((counts, entry) => {
      counts[entry.refusalReason ?? 'unknown'] = (counts[entry.refusalReason ?? 'unknown'] ?? 0) + 1
      return counts
    }, {}),
    byStage: ['writer-only', 'continuation'].reduce((counts, stage) => {
      const rows = resolved.filter(entry => entry.stage === stage)
      counts[stage] = {
        refusedDeltas: rows.length,
        machineState: rows.filter(entry => entry.inMachineState).length,
        narrativeOnly: rows.filter(entry => !entry.inMachineState && (entry.inHandoff || entry.inCheckpoint)).length,
        notVisible: rows.filter(entry => !entry.inMachineState && !entry.inHandoff && !entry.inCheckpoint).length,
      }
      return counts
    }, {}),
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dataset: { id: 'r33-semantic-continuity-v2', digest: datasetDigest },
    sourceCommitAtAudit: '914ed317ae022ac9c5fe39f098d406b7ce03c8da',
    sourceCommitNote: 'The R35 reports do not contain a per-run git SHA. The commit above is the R35 branch HEAD at which these artifacts were audited; it is not presented as the commit that produced each run.',
    reports: reports.map(entry => ({
      file: entry.file,
      runId: entry.report.runId,
      stage: entry.report.stage,
      status: entry.report.status,
      generatedAt: entry.report.generatedAt,
      model: entry.report.model,
      routeEnv: entry.report.route?.baseUrlEnv ?? null,
      digest: reportDigest(entry.raw),
      ledgerAttempts: entry.report.ledger?.used?.attempts ?? null,
    })),
    writerAttempts: {
      total: attempts.length,
      scoreable: attempts.filter(entry => !entry.rowLost).length,
      lostRows: attempts.filter(entry => entry.rowLost).length,
      parsed: attempts.filter(entry => entry.protocolCategory === 'parsed').length,
      nonParsed: attempts.filter(entry => entry.protocolCategory !== 'parsed').length,
      categories,
      perCase,
      rows: attempts.map(({ rawText, proposedDeltas, acceptedDeltas, refusedDeltas, caseData, ...row }) => row),
    },
    factFunnel: {
      perAttempt: funnel,
      perCase: perCaseFunnel,
      overall: overallFunnel,
      note: 'Means are over scoreable attempts, not the best replicate. A lost row is reported as unknown, never as zero.',
    },
    handoffExposure: {
      totals: exposureTotals,
      rows: exposure,
      note: 'Exposure measurement only; no Handoff Validator was added. narrative-only means the claim survived in prose, not in machine state.',
    },
  }
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`writer attempts: ${report.writerAttempts.total} (${report.writerAttempts.scoreable} scoreable, ${report.writerAttempts.lostRows} lost)\n`)
  process.stdout.write(`protocol: ${JSON.stringify(categories)}\n`)
  for (const [caseId, bucket] of Object.entries(perCase).sort()) {
    process.stdout.write(`  ${caseId}: ${bucket.parsed}/${bucket.scoreable} parsed (${JSON.stringify(bucket.categories)})\n`)
  }
  process.stdout.write(`funnel means: ${JSON.stringify(overallFunnel)}\n`)
  process.stdout.write(`handoff exposure: ${JSON.stringify(exposureTotals)}\n`)
  process.stdout.write(`${OUT}\n`)
  process.exit(0)
}

await main()
