/**
 * R4-F: the default-flip eligibility gate.
 *
 * R4 §36 states the release decision as a conjunction over five independent
 * components, and the shape is the whole point: no single green number can
 * authorize a production default. A spectacular RBCR with unmeasured quality
 * is not an eligible release, and neither is a fully measured quality result
 * with one regressed invariant.
 *
 * The implementation follows from three rules:
 *
 * 1. **Three states, not two.** `satisfied` / `open` / `violated`. R3 already
 *    had to split "cost gate PASS/FAIL" from "quality gate PASS/FAIL/OPEN",
 *    because conflating "not measured" with "passed" is how an unmeasured
 *    claim becomes a shipped one.
 * 2. **A missing component is `open`, never satisfied.** Omitting a check must
 *    not be a way to pass it.
 * 3. **The verdict names its blockers.** A release decision whose reason is
 *    "something failed" is not actionable; the gate reports WHICH component
 *    and why.
 *
 * @module eval/eligibility
 */

/** One component of the release gate. */
export interface EligibilityComponent {
  /** `R` | `C` | `Q` | `W` | `I` (R4 §36), or a finer-grained sub-check. */
  readonly id: string
  readonly state: 'satisfied' | 'open' | 'violated'
  /** What was measured, or what is missing. Never a restatement of the state. */
  readonly detail: string
}

/** The five required components (R4 §36), in report order. */
export const REQUIRED_COMPONENTS = ['R', 'C', 'Q', 'W', 'I'] as const

/** What each component means, so a report needs no external legend. */
export const COMPONENT_MEANING: Readonly<Record<string, string>> = {
  R: 'Runtime — the framing seam is a supported dependency, idle rebase is on the production path, no benchmark-only behavior',
  C: 'Cost — RBCR < 1 on real provider bills, with the aggregate CI upper bound below 1',
  Q: 'Quality — live paired non-inferiority',
  W: 'Window — no context overflow, adequate main-request headroom',
  I: 'Invariants — every epistemic correctness gate at zero regression',
}

/** The gate's verdict. */
export interface EligibilityVerdict {
  readonly eligible: boolean
  /** Components that are `open` or `violated`, in requirement order. */
  readonly blocking: readonly EligibilityComponent[]
  /** Components not supplied at all; treated as `open`. */
  readonly missing: readonly string[]
  readonly reason: string
}

/**
 * Whether the economy mode may become the production default (R4 §36).
 *
 * @param components - the evaluated components. Ids match
 *   {@link REQUIRED_COMPONENTS}; extra ids are reported but do not gate.
 * @returns the verdict, with every blocker named.
 */
export function economyDefaultEligible(
  components: readonly EligibilityComponent[],
): EligibilityVerdict {
  const byId = new Map(components.map(component => [component.id, component]))
  const blocking: EligibilityComponent[] = []
  const missing: string[] = []

  for (const id of REQUIRED_COMPONENTS) {
    const component = byId.get(id)
    if (component === undefined) {
      // Omitting a check is not a way to pass it.
      missing.push(id)
      continue
    }
    if (component.state !== 'satisfied') blocking.push(component)
  }

  if (missing.length === 0 && blocking.length === 0) {
    return {
      eligible: true,
      blocking: [],
      missing: [],
      reason: 'every component satisfied: ' + REQUIRED_COMPONENTS.join(', '),
    }
  }

  const parts: string[] = []
  if (blocking.length > 0) {
    parts.push(
      blocking.map(component => `${component.id} ${component.state} (${component.detail})`).join('; '),
    )
  }
  if (missing.length > 0) {
    parts.push(`${missing.join(', ')} not evaluated`)
  }
  return {
    eligible: false,
    blocking,
    missing,
    reason: parts.join('; '),
  }
}

/** Render the gate as Markdown, softening no state. */
export function summarizeEligibility(components: readonly EligibilityComponent[]): string {
  const verdict = economyDefaultEligible(components)
  const byId = new Map(components.map(component => [component.id, component]))
  const lines = [
    `**EconomyDefaultEligible: ${verdict.eligible ? 'ELIGIBLE' : 'NOT eligible'}**`,
    '',
    '| Component | State | Evidence |',
    '|---|---|---|',
  ]
  for (const id of REQUIRED_COMPONENTS) {
    const component = byId.get(id)
    const state = component?.state ?? 'open'
    const detail = component?.detail ?? 'not evaluated'
    lines.push(`| ${id} — ${COMPONENT_MEANING[id] ?? ''} | ${state} | ${detail} |`)
  }
  lines.push('', `${verdict.eligible ? 'Gate: PASS' : `Gate: BLOCKED — ${verdict.reason}`}`)
  return lines.join('\n')
}
