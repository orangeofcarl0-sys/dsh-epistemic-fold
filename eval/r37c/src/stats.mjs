/**
 * R37-C0-D: paired statistics with the case as the sampling unit.
 *
 * The R37-B Stage 2 result has 36 pairs from six cases, six replicates each.
 * The exact McNemar test on 36 pairs is arithmetically correct, but it treats
 * correlated replicates as independent. This module keeps the original test
 * and adds per-case effects, leave-one-case-out, a sign test, and a
 * case-clustered bootstrap. None of these is a population estimate.
 *
 * @module eval/r37c/src/stats
 */

export function combinations(n, k) {
  if (k < 0 || k > n) return 0
  let value = 1
  for (let index = 1; index <= k; index += 1) value = value * (n - k + index) / index
  return value
}

export function exactMcNemar(wins, losses) {
  const n = wins + losses
  if (n === 0) return { wins, losses, n: 0, p: null, note: 'no discordant pairs' }
  const tail = Math.min(wins, losses)
  let probability = 0
  for (let index = 0; index <= tail; index += 1) {
    probability += combinations(n, index) / (2 ** n)
  }
  return {
    wins,
    losses,
    n,
    p: Math.min(1, 2 * probability),
    method: 'two-sided exact binomial on discordant pairs',
  }
}

export function signTest(negative, positive) {
  const n = negative + positive
  if (n === 0) return { negative, positive, n: 0, p: null, note: 'no non-zero case effects' }
  const tail = Math.min(negative, positive)
  let probability = 0
  for (let index = 0; index <= tail; index += 1) {
    probability += combinations(n, index) / (2 ** n)
  }
  return {
    negative,
    positive,
    n,
    p: Math.min(1, 2 * probability),
    method: 'two-sided exact sign test on case-level direction; ties excluded',
  }
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

export function perCase(pairs, selector) {
  const byCase = new Map()
  for (const pair of pairs) {
    if (!byCase.has(pair.caseId)) byCase.set(pair.caseId, [])
    byCase.get(pair.caseId).push(pair)
  }
  return [...byCase.keys()].sort().map(caseId => {
    const selected = byCase.get(caseId)
    const s = selected.filter(pair => selector(pair.treatment) === true).length
    const b1 = selected.filter(pair => selector(pair.baseline) === true).length
    return {
      caseId,
      pairs: selected.length,
      sSuccesses: s,
      b1Successes: b1,
      sRate: s / selected.length,
      b1Rate: b1 / selected.length,
      difference: (s - b1) / selected.length,
      rescue: selected.filter(pair => selector(pair.baseline) !== true && selector(pair.treatment) === true).length,
      damage: selected.filter(pair => selector(pair.baseline) === true && selector(pair.treatment) !== true).length,
      both: selected.filter(pair => selector(pair.baseline) === true && selector(pair.treatment) === true).length,
      neither: selected.filter(pair => selector(pair.baseline) !== true && selector(pair.treatment) !== true).length,
    }
  })
}

export function leaveOneCaseOut(pairs, selector) {
  const cases = [...new Set(pairs.map(pair => pair.caseId))].sort()
  return cases.map(excluded => {
    const selected = pairs.filter(pair => pair.caseId !== excluded)
    const wins = selected.filter(pair => selector(pair.baseline) !== true && selector(pair.treatment) === true).length
    const losses = selected.filter(pair => selector(pair.baseline) === true && selector(pair.treatment) !== true).length
    const s = selected.filter(pair => selector(pair.treatment) === true).length
    const b1 = selected.filter(pair => selector(pair.baseline) === true).length
    return {
      excluded,
      pairs: selected.length,
      rescue: wins,
      damage: losses,
      sRate: s / selected.length,
      b1Rate: b1 / selected.length,
      difference: (s - b1) / selected.length,
      ...exactMcNemar(wins, losses),
    }
  })
}

export function clusterBootstrap(pairs, selector, iterations = 10_000, seed = 3701) {
  const byCase = new Map()
  for (const pair of pairs) {
    if (!byCase.has(pair.caseId)) byCase.set(pair.caseId, [])
    byCase.get(pair.caseId).push(pair)
  }
  const cases = [...byCase.keys()].sort()
  if (cases.length === 0) return { iterations, cases: 0, difference: null, ci95: null }
  const random = mulberry32(seed)
  const observedS = pairs.filter(pair => selector(pair.treatment) === true).length / pairs.length
  const observedB1 = pairs.filter(pair => selector(pair.baseline) === true).length / pairs.length
  const differences = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = []
    for (let draw = 0; draw < cases.length; draw += 1) {
      const caseId = cases[Math.floor(random() * cases.length)]
      sample.push(...byCase.get(caseId))
    }
    const s = sample.filter(pair => selector(pair.treatment) === true).length / sample.length
    const b1 = sample.filter(pair => selector(pair.baseline) === true).length / sample.length
    differences.push(s - b1)
  }
  differences.sort((left, right) => left - right)
  return {
    iterations,
    cases: cases.length,
    observedS,
    observedB1,
    difference: observedS - observedB1,
    ci95: [quantile(differences, 0.025), quantile(differences, 0.975)],
    note: 'Case-clustered bootstrap of the S-minus-B1 rate difference; six cases make it descriptive.',
  }
}

export function summarize(pairs, selector) {
  const wins = pairs.filter(pair => selector(pair.baseline) !== true && selector(pair.treatment) === true).length
  const losses = pairs.filter(pair => selector(pair.baseline) === true && selector(pair.treatment) !== true).length
  const s = pairs.filter(pair => selector(pair.treatment) === true).length
  const b1 = pairs.filter(pair => selector(pair.baseline) === true).length
  const cases = perCase(pairs, selector)
  const negative = cases.filter(entry => entry.difference < 0).length
  const positive = cases.filter(entry => entry.difference > 0).length
  return {
    pairs: pairs.length,
    sSuccesses: s,
    b1Successes: b1,
    sRate: pairs.length === 0 ? null : s / pairs.length,
    b1Rate: pairs.length === 0 ? null : b1 / pairs.length,
    difference: pairs.length === 0 ? null : (s - b1) / pairs.length,
    rescue: wins,
    damage: losses,
    both: pairs.filter(pair => selector(pair.baseline) === true && selector(pair.treatment) === true).length,
    neither: pairs.filter(pair => selector(pair.baseline) !== true && selector(pair.treatment) !== true).length,
    mcnemar: exactMcNemar(wins, losses),
    bootstrap: clusterBootstrap(pairs, selector),
    byCase: cases,
    caseDirection: { negative, positive, flat: cases.length - negative - positive },
    signTest: signTest(negative, positive),
  }
}
