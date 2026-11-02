/**
 * Case selection: the caller's order is the execution order.
 *
 * R35 filtered the dataset with `ids.includes(entry.id)`, so the order was the
 * dataset's, not the operator's. That silently defeated `--cases F1,A1` for
 * interleaving, randomisation, budget-censoring studies, and any comparison
 * that depends on which case runs first. A requested id that does not exist was
 * dropped without a word, which made a typo look like a complete run.
 *
 * This module is deliberately tiny and pure so the order rule is testable
 * without starting a provider or a fold.
 *
 * @module eval/r33/src/selection
 */

/**
 * Select cases in the requested order.
 *
 * @param {readonly object[]} cases - the loaded dataset, in dataset order.
 * @param {string|undefined} requested - comma-separated case ids.
 * @returns {object[]} cases in request order (the full dataset when omitted).
 * @throws {Error} on an unknown id or a duplicate id. A duplicate is refused
 *   rather than silently deduplicated: it changes the planned request count and
 *   the replicate identity, so the operator must choose explicitly.
 */
export function selectCases(cases, requested) {
  if (requested === undefined || requested === null) return cases
  const text = String(requested).trim()
  if (text.length === 0) return cases
  const ids = text.split(',').map(id => id.trim()).filter(Boolean)
  if (ids.length === 0) return cases
  const byId = new Map(cases.map(entry => [entry.id, entry]))
  const selected = []
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`duplicate case id "${id}"; each case may appear once per run`)
    }
    seen.add(id)
    const entry = byId.get(id)
    if (entry === undefined) {
      const available = [...byId.keys()].join(', ')
      throw new Error(`unknown case id "${id}"; available cases: ${available}`)
    }
    selected.push(entry)
  }
  return selected
}
