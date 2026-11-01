/**
 * R33 case schema validation.
 *
 * The dataset is frozen before any model runs, so the validator is deliberately
 * strict about the parts that make a case CAUSAL: a gold fact must cite a real
 * transcript entry and quote text that is actually there, every decision probe
 * must name an existing action, and a history-dependent case must not leak its
 * gold into the workspace the follow-up agent can read.
 *
 * A failed validation is `invalid-benchmark`, never a silently skipped case.
 *
 * @module eval/r33/src/schema
 */

export const CASE_SCHEMA_VERSION = 1

export const RISK_CLASSES = [
  'persistent-constraint',
  'decision-override',
  'negative-knowledge',
  'validation-boundary',
  'cross-phase-dependency',
  'authority-scope',
  'retrieval-trigger',
  'history-independent',
]

const ROLES = new Set(['user', 'assistant', 'tool'])
const KINDS = new Set([
  'constraint', 'objective', 'obligation', 'decision', 'rejected-approach',
  'experience-candidate', 'finding', 'artifact',
])
const CRITICALITY = new Set(['high', 'medium', 'low'])

function fail(id, path, detail) {
  return { ok: false, code: 'case-schema', detail: `${id}: ${path}: ${detail}` }
}

function string(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function transcriptText(transcript) {
  return transcript.map(entry => entry.text).join('\n')
}

/**
 * Validate one case.
 *
 * @param {unknown} raw - parsed JSON.
 * @returns {{ok:true, case:object}|{ok:false, code:string, detail:string}}
 */
export function validateCase(raw) {
  if (raw === null || typeof raw !== 'object') return { ok: false, code: 'case-schema', detail: 'case is not an object' }
  const data = raw
  const id = string(data.id) ? data.id : '<missing-id>'
  if (data.schemaVersion !== CASE_SCHEMA_VERSION) return fail(id, 'schemaVersion', `expected ${CASE_SCHEMA_VERSION}`)
  if (!string(data.id)) return fail(id, 'id', 'required')
  if (!RISK_CLASSES.includes(data.riskClass)) return fail(id, 'riskClass', `unknown class ${data.riskClass}`)
  if (typeof data.historyIndependent !== 'boolean') return fail(id, 'historyIndependent', 'required')
  if (!string(data.task)) return fail(id, 'task', 'required')

  const transcript = data.transcript
  if (!Array.isArray(transcript) || transcript.length === 0) return fail(id, 'transcript', 'non-empty array required')
  for (const [index, entry] of transcript.entries()) {
    if (entry === null || typeof entry !== 'object') return fail(id, `transcript[${index}]`, 'not an object')
    if (!ROLES.has(entry.role)) return fail(id, `transcript[${index}].role`, `unknown role ${entry.role}`)
    if (!string(entry.text)) return fail(id, `transcript[${index}].text`, 'required')
    if (entry.role === 'tool' && !string(entry.name)) return fail(id, `transcript[${index}].name`, 'tool results need a name')
  }

  const writer = data.writer
  if (writer === null || typeof writer !== 'object') return fail(id, 'writer', 'required')
  if (typeof writer.handoff !== 'string') return fail(id, 'writer.handoff', 'required')
  if (!Array.isArray(writer.deltas)) return fail(id, 'writer.deltas', 'array required (may be empty)')

  const gold = data.gold
  if (!Array.isArray(gold) || gold.length === 0) return fail(id, 'gold', 'non-empty array required')
  const text = transcriptText(transcript)
  for (const [index, fact] of gold.entries()) {
    const where = `gold[${index}]`
    if (!string(fact.factId)) return fail(id, `${where}.factId`, 'required')
    if (!KINDS.has(fact.kind)) return fail(id, `${where}.kind`, `unknown kind ${fact.kind}`)
    if (!string(fact.statement)) return fail(id, `${where}.statement`, 'required')
    if (!string(fact.subjectKey)) return fail(id, `${where}.subjectKey`, 'required')
    if (!CRITICALITY.has(fact.criticality)) return fail(id, `${where}.criticality`, 'unknown value')
    if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) {
      return fail(id, `${where}.sourceRefs`, 'non-empty array required')
    }
    for (const ref of fact.sourceRefs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= transcript.length) {
        return fail(id, `${where}.sourceRefs`, `index ${ref} is outside the transcript`)
      }
    }
    if (!string(fact.quote)) return fail(id, `${where}.quote`, 'required')
    if (!text.includes(fact.quote)) return fail(id, `${where}.quote`, 'quote is not verbatim in the transcript')
    if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) return fail(id, where, 'sourceRefs required')
    if (typeof fact.current !== 'boolean') return fail(id, `${where}.current`, 'boolean required')
    if (!string(fact.visibleNeedle)) return fail(id, `${where}.visibleNeedle`, 'required')
    if (!string(fact.expectedBehavior)) return fail(id, `${where}.expectedBehavior`, 'required')
    if (fact.scope !== undefined) {
      if (fact.scope === null || typeof fact.scope !== 'object' || Array.isArray(fact.scope)) {
        return fail(id, `${where}.scope`, 'object required when present')
      }
      for (const [key, value] of Object.entries(fact.scope)) {
        if (!string(key) || !string(value)) return fail(id, `${where}.scope.${key}`, 'non-empty strings required')
      }
    }
    if (fact.oracleEvidence !== undefined) {
      if (!Array.isArray(fact.oracleEvidence) || fact.oracleEvidence.length === 0) {
        return fail(id, `${where}.oracleEvidence`, 'non-empty array required when present')
      }
      for (const quote of fact.oracleEvidence) {
        if (!string(quote)) return fail(id, `${where}.oracleEvidence`, 'quotes must be non-empty strings')
        if (!text.includes(quote)) return fail(id, `${where}.oracleEvidence`, 'quote is not verbatim in the transcript')
      }
    }
  }

  const workspace = data.workspace
  if (workspace === null || typeof workspace !== 'object' || workspace.files === null
    || typeof workspace.files !== 'object' || Object.keys(workspace.files).length === 0) {
    return fail(id, 'workspace.files', 'non-empty object required')
  }
  for (const [path, content] of Object.entries(workspace.files)) {
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      return fail(id, `workspace.files[${path}]`, 'path must be a relative POSIX path without ..')
    }
    if (typeof content !== 'string') return fail(id, `workspace.files[${path}]`, 'content must be a string')
  }

  // No-gold-leakage: a history-dependent case must not carry the answer in a
  // file the follow-up agent can read (README, comments, or tests included).
  if (data.historyIndependent === false) {
    const files = Object.entries(workspace.files)
    for (const [index, fact] of gold.entries()) {
      for (const [path, content] of files) {
        if (content.includes(fact.quote)) {
          return fail(id, `workspace.files[${path}]`, `leaks gold[${index}].quote`)
        }
        if (content.includes(fact.visibleNeedle)) {
          return fail(id, `workspace.files[${path}]`, `leaks gold[${index}].visibleNeedle`)
        }
      }
    }
  }

  const actions = data.actions
  if (actions === null || typeof actions !== 'object' || Object.keys(actions).length === 0) {
    return fail(id, 'actions', 'non-empty object required')
  }
  for (const [name, action] of Object.entries(actions)) {
    if (action === null || typeof action !== 'object') return fail(id, `actions.${name}`, 'not an object')
    if (action.files !== undefined) {
      if (typeof action.files !== 'object' || action.files === null) return fail(id, `actions.${name}.files`, 'object required')
      for (const [path, content] of Object.entries(action.files)) {
        if (typeof content !== 'string') return fail(id, `actions.${name}.files[${path}]`, 'content must be a string')
      }
    }
    if (action.testsExecuted !== undefined && !Number.isInteger(action.testsExecuted)) {
      return fail(id, `actions.${name}.testsExecuted`, 'integer required')
    }
  }
  const decision = data.decision
  if (decision === null || typeof decision !== 'object') return fail(id, 'decision', 'required')
  if (!string(decision.default) || actions[decision.default] === undefined) {
    return fail(id, 'decision.default', 'must name an action')
  }
  if (!Array.isArray(decision.probes)) return fail(id, 'decision.probes', 'array required')
  for (const [index, probe] of decision.probes.entries()) {
    const hasSingle = string(probe.contextIncludes)
    const hasMany = Array.isArray(probe.contextIncludesAny)
      && probe.contextIncludesAny.length > 0
      && probe.contextIncludesAny.every(string)
    if (!hasSingle && !hasMany) {
      return fail(id, `decision.probes[${index}]`, 'contextIncludes or a non-empty contextIncludesAny is required')
    }
    if (probe.unlessContextIncludesAny !== undefined
      && (!Array.isArray(probe.unlessContextIncludesAny)
        || probe.unlessContextIncludesAny.length === 0
        || !probe.unlessContextIncludesAny.every(string))) {
      return fail(id, `decision.probes[${index}].unlessContextIncludesAny`, 'non-empty string array required')
    }
    if (!string(probe.action) || actions[probe.action] === undefined) {
      return fail(id, `decision.probes[${index}].action`, 'must name an action')
    }
  }
  if (data.forbiddenAction !== undefined && actions[data.forbiddenAction] === undefined) {
    return fail(id, 'forbiddenAction', 'must name an action')
  }
  if (data.falseMemory !== undefined) {
    const fault = data.falseMemory
    if (fault === null || typeof fault !== 'object') return fail(id, 'falseMemory', 'object required')
    if (!string(fault.statement)) return fail(id, 'falseMemory.statement', 'required')
    if (!string(fault.contextIncludes)) return fail(id, 'falseMemory.contextIncludes', 'required')
    if (!fault.statement.includes(fault.contextIncludes)) {
      return fail(id, 'falseMemory.contextIncludes', 'must be a substring of the injected statement')
    }
    if (!string(fault.action) || actions[fault.action] === undefined) {
      return fail(id, 'falseMemory.action', 'must name an action')
    }
  }

  const checker = data.checker
  if (checker === null || typeof checker !== 'object' || !string(checker.source)) {
    return fail(id, 'checker.source', 'required')
  }
  if (!checker.source.includes('R33_RESULT')) {
    return fail(id, 'checker.source', 'must emit an R33_RESULT JSON line')
  }

  return { ok: true, case: data }
}
