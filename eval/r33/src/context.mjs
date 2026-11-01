/**
 * The visible context each arm is allowed to give the follow-up agent.
 *
 * The construction is intentionally mechanical so no arm gets an unearned
 * advantage:
 *
 *   B0/B1/S   the checkpoint the real fold produced (+ the task)
 *   F         the entire frozen transcript (+ the task)
 *   N         the task alone
 *   O2        the correct gold facts as a compact block (+ the task)
 *   OR        the task + the gold EVIDENCE quotes, not the claims
 *
 * `O2` is the behavioural upper bound "the agent knows the right facts"; `OR`
 * is the retrieval upper bound "the agent is handed the right history on
 * request". Neither includes the final code or hidden-test outcomes.
 *
 * The B0/B1 baseline summary is extractive and deterministic: the first 120
 * characters of each user message and the first 80 of each tool result. It is
 * deliberately a REAL summary, not a strawman, and it is the same body for
 * native Basic and EF-off so the semantic layer is the only difference.
 *
 * @module eval/r33/src/context
 */

/** Deterministic extractive summary used as the Basic / EF-off baseline. */
export function literalSummary(transcript) {
  const lines = []
  for (const entry of transcript) {
    if (entry.role === 'user') {
      lines.push(`User: ${entry.text.slice(0, 120).replace(/\s+/gu, ' ')}`)
    } else if (entry.role === 'tool') {
      lines.push(`Tool ${entry.name}: ${entry.text.slice(0, 80).replace(/\s+/gu, ' ')}`)
    } else {
      lines.push('Assistant: acknowledged.')
    }
  }
  return lines.join('\n')
}

/** The full frozen transcript, role-prefixed. */
export function fullHistory(transcript) {
  return transcript
    .map(entry => `${entry.role === 'tool' ? `tool:${entry.name}` : entry.role}: ${entry.text}`)
    .join('\n\n')
}

/**
 * The correct minimal facts an oracle-visible arm may show.
 *
 * Superseded facts are EXCLUDED by default: R33 included them, so O2 was shown
 * a claim the conversation had already replaced. "Minimal correct facts" means
 * the current state, not the whole history of it.
 */
export function goldFactsBlock(gold, options = {}) {
  const facts = options.includeSuperseded === true ? gold : gold.filter(fact => fact.current)
  return [
    'ACTION-CRITICAL FACTS (provided by the evaluation, not by the checkpoint):',
    ...facts.map(fact => `- [${fact.kind}] ${fact.statement}`),
    'END ACTION-CRITICAL FACTS',
  ].join('\n')
}

/**
 * The gold evidence quotes, without the claims they support.
 *
 * Like {@link goldFactsBlock}, current facts only unless asked otherwise.
 */
export function goldEvidenceBlock(gold, transcript, options = {}) {
  const facts = options.includeSuperseded === true ? gold : gold.filter(fact => fact.current)
  const lines = ['HISTORICAL EVIDENCE (verbatim; interpret it yourself):']
  for (const fact of facts) {
    for (const ref of fact.sourceRefs) {
      const entry = transcript[ref]
      lines.push(`- [${entry.role}${entry.role === 'tool' ? `:${entry.name}` : ''}] ${fact.quote}`)
    }
  }
  lines.push('END HISTORICAL EVIDENCE')
  return lines.join('\n')
}

/** Append the current task after whichever context the arm provides. */
export function withTask(context, task) {
  return `${context}\n\nCURRENT TASK:\n${task}`
}

/**
 * The scripted follow-up agent's decision rule.
 *
 * It reads ONLY the arm's visible context. First matching probe wins; the
 * default is the action a competent agent would take without the historical
 * fact. This is a DELIVERY probe, not a model simulation: it proves the
 * pipeline can carry a fact to an action, and that a missing or false fact
 * changes the action.
 */
export function scriptedDecision(caseData, context) {
  const haystack = context.toLowerCase()
  for (const probe of caseData.decision.probes) {
    // An authority-aware probe may be suppressed when the REAL requirement is
    // visible. That is the scripted stand-in for "a user message outranks a
    // tool result": full history and the semantic state carry the user line,
    // while a truncated baseline summary may carry only the tool text.
    const unless = probe.unlessContextIncludesAny ?? []
    if (unless.some(needle => haystack.includes(needle.toLowerCase()))) continue
    const needles = probe.contextIncludesAny ?? [probe.contextIncludes]
    const matched = needles.find(needle => haystack.includes(needle.toLowerCase()))
    if (matched !== undefined) {
      return { action: probe.action, matchedProbe: matched, basis: 'historical-fact' }
    }
  }
  return { action: caseData.decision.default, matchedProbe: null, basis: 'no-fact-visible' }
}

/**
 * The instruction the live follow-up agent receives.
 *
 * Deliberately contains no risk class, arm name, or other evaluation metadata:
 * R33 told the agent which risk class was under test, which can cue the exact
 * behavior the case is trying to measure.
 */
export function followUpSystemPrompt() {
  return [
    'You are continuing a real software task after a context compaction.',
    'You may read and edit files in the workspace and run its visible tests.',
    'The checkpoint or facts above are your memory of the earlier conversation.',
    'Do the task now. Do not claim a test was run unless you ran it.',
  ].join('\n')
}
