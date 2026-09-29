/**
 * RC1-D §27/§28: cache contract compliance, checked as request SHAPE.
 *
 * The project has paid real money twice to learn things about provider caching
 * that a static inspection of the request shape can answer for free:
 *
 *   - does the stable portion stay byte-identical between two requests?
 *   - is the EF system section constant, deterministic, and early?
 *   - are tool schemas stably ordered?
 *   - does a leaf change the prefix as LATE as possible?
 *   - is a root rare and economically justified rather than incidental?
 *
 * A violation of any of these invalidates a prefix for no epistemic gain: the
 * model sees exactly the same information and the bill goes up. So these are
 * cheap invariants worth asserting on every push, not experiments worth
 * running against a provider.
 *
 * Two rules shape the checks:
 *
 * 1. **The prefix must be byte-equal, not semantically equal.** A timestamp, a
 *    random UUID, or a reordered tool list above the cache boundary breaks
 *    reuse even though the model cannot tell. `ByteEqual(prefix₁, prefix₂)` is
 *    the assertion, and a hash is the comparison.
 *
 * 2. **A cache-miss caused by a STRUCTURAL change is not a defect.** A leaf
 *    fold legitimately rewrites the surface; the contract is that it does so as
 *    late as possible, not that it never does. The checks distinguish "the
 *    prefix changed because the policy decided to change it" from "the prefix
 *    changed because something non-deterministic leaked in".
 *
 * @module eval/src/cache-contract
 */

/** One request's shape, reduced to the parts a cache boundary depends on. */
export interface RequestShape {
  /** The system-prompt text, in assembly order. */
  readonly system: string
  /** Tool names, in the order they would be declared. */
  readonly toolNames: readonly string[]
  /** Per-message content digests, in surface order. */
  readonly messageDigests: readonly string[]
}

/** One contract violation, with the evidence that produced it. */
export interface ContractViolation {
  readonly rule: string
  readonly detail: string
}

/** The result of comparing two requests, or inspecting one. */
export interface ContractReport {
  readonly compliant: boolean
  readonly violations: readonly ContractViolation[]
}

/**
 * How many leading messages two requests share byte-for-byte.
 *
 * This is the cacheable prefix length, and it is what a leaf fold is supposed
 * to maximize: the fold should rewrite as few leading messages as possible.
 *
 * @param previous - the earlier request's shape.
 * @param current - the later request's shape.
 * @returns the shared leading count.
 */
export function sharedPrefixLength(previous: RequestShape, current: RequestShape): number {
  const shared = Math.min(previous.messageDigests.length, current.messageDigests.length)
  for (let index = 0; index < shared; index += 1) {
    if (previous.messageDigests[index] !== current.messageDigests[index]) return index
  }
  return shared
}

/**
 * Check that two requests generated from the same state are byte-identical
 * (RC1-D §28).
 *
 * This is the determinism test: same session state, two assemblies, and the
 * stable portion must be byte-equal. Anything else means a non-deterministic
 * value — a timestamp, a random id, an unordered map iteration — sits above the
 * cache boundary, where it costs money and buys nothing.
 *
 * @param first - the first assembly.
 * @param second - the second assembly of the same state.
 * @returns the verdict, naming the first differing field.
 */
export function checkPrefixDeterminism(first: RequestShape, second: RequestShape): ContractReport {
  const violations: ContractViolation[] = []
  if (first.system !== second.system) {
    violations.push({
      rule: 'system-determinism',
      detail: 'two assemblies of the same state produced different system prompts',
    })
  }
  if (first.toolNames.join(',') !== second.toolNames.join(',')) {
    violations.push({
      rule: 'tool-order-determinism',
      detail: `tool declaration order differs: [${first.toolNames.join(', ')}] vs `
        + `[${second.toolNames.join(', ')}]`,
    })
  }
  const shared = sharedPrefixLength(first, second)
  if (shared !== Math.min(first.messageDigests.length, second.messageDigests.length)) {
    violations.push({
      rule: 'message-determinism',
      detail: `messages diverge at index ${shared} between two assemblies of the same state`,
    })
  }
  return { compliant: violations.length === 0, violations }
}

/**
 * Check the EF-specific cache contract (RC1-D §29/§30).
 *
 * Three properties, each of which is cheap to state and expensive to lose:
 *
 *   - the EF framing section, when present, is EARLY: it belongs at the very
 *     front of the system prompt, where it is cache-stable forever
 *   - the recall tools keep a STABLE ORDER: a session-state-dependent reorder
 *     invalidates the tool block for no epistemic gain
 *   - the section is CONSTANT: it is a literal, so a change here is a change to
 *     the product's semantics, not a per-request variation
 *
 * "Early" is not "first at index 0". DSH's own `harness:identity` section
 * legitimately precedes it and is itself constant, so what the contract
 * actually requires is that the framing section appears before any
 * DEPLOYMENT-owned content and that everything ahead of it is stable. The
 * caller states the bound; `maxIndex` defaults to 0 so a deployment that puts
 * it first is checked strictly, and a caller with a known constant preamble
 * passes that preamble's length.
 *
 * @param shape - the request shape.
 * @param options - the framing section text, its permitted offset, and the
 *   required tool order.
 * @returns the verdict.
 */
export function checkEfCacheContract(
  shape: RequestShape,
  options: {
    readonly framingSection?: string
    readonly requiredToolOrder?: readonly string[]
    /** How far into the system prompt the framing section may appear. */
    readonly framingMaxIndex?: number
    /**
     * Text that legitimately precedes the framing section. When supplied, the
     * bound is derived from it, so the check follows the deployment rather than
     * a magic number.
     */
    readonly constantPreamble?: string
  } = {},
): ContractReport {
  const violations: ContractViolation[] = []
  const framing = options.framingSection
  if (framing !== undefined) {
    const index = shape.system.indexOf(framing)
    if (index < 0) {
      // Absent is legitimate: a `legacy` deployment has no such section.
    } else {
      const preceding = shape.system.slice(0, index)
      if (options.constantPreamble !== undefined) {
        // The real invariant: everything ahead of the framing section is the
        // known constant preamble plus section separators, and nothing else.
        // Comparing against a character OFFSET would encode the separator
        // width as a magic number; comparing the TEXT states the property that
        // actually matters, which is that no per-session content got in front.
        const expected = options.constantPreamble.replace(/\s+$/u, '')
        if (preceding.replace(/\s+$/u, '') !== expected) {
          violations.push({
            rule: 'framing-not-early',
            detail: `the text before the EF framing section is not the constant preamble; got `
              + `${JSON.stringify(preceding.slice(0, 120))}`,
          })
        }
      } else {
        const maxIndex = options.framingMaxIndex ?? 0
        if (index > maxIndex) {
          violations.push({
            rule: 'framing-not-early',
            detail: `the EF framing section appears at character ${index}, past the permitted ${maxIndex}`,
          })
        }
      }
    }
  }

  const required = options.requiredToolOrder
  if (required !== undefined) {
    const present = required.filter(name => shape.toolNames.includes(name))
    const actual = shape.toolNames.filter(name => required.includes(name))
    if (present.join(',') !== actual.join(',')) {
      violations.push({
        rule: 'recall-tool-order',
        detail: `recall tools are declared as [${actual.join(', ')}] but the stable order is `
          + `[${present.join(', ')}]`,
      })
    }
  }
  return { compliant: violations.length === 0, violations }
}

/**
 * Whether a leaf fold rewrote the prefix as LATE as possible (RC1-D §27).
 *
 * A leaf fold is allowed to change the surface; what it must not do is
 * invalidate messages BEFORE the fold region, which the model had already
 * priced and which the fold's own summary supersedes. So the first mutation
 * position must be at or after the fold's start.
 *
 * @param firstMutationIndex - index of the first message that changed.
 * @param foldStartIndex - index where the folded region begins.
 * @returns the verdict.
 */
export function checkLeafMutatesLate(
  firstMutationIndex: number,
  foldStartIndex: number,
): ContractReport {
  if (firstMutationIndex < foldStartIndex) {
    return {
      compliant: false,
      violations: [{
        rule: 'leaf-mutates-late',
        detail: `the fold first changed message ${firstMutationIndex}, BEFORE the folded region `
          + `starts at ${foldStartIndex}; every message before the region was invalidated for nothing`,
      }],
    }
  }
  return { compliant: true, violations: [] }
}

/**
 * Whether a root rebase was rare enough to be economic (RC1-D §27).
 *
 * A root rewrites the frozen prefix, so it invalidates cache that a leaf would
 * have preserved. The contract is not "never" — it is "rare, and only when the
 * economics justified it". A root on nearly every step is the thrash the
 * anti-oscillation cooldown exists to prevent.
 *
 * @param rootFolds - roots performed.
 * @param leafFolds - leaf folds performed.
 * @param options - the maximum permitted roots-per-leaf share.
 * @returns the verdict.
 */
export function checkRootRarity(
  rootFolds: number,
  leafFolds: number,
  options: { readonly maxRootShare?: number } = {},
): ContractReport {
  const maxShare = options.maxRootShare ?? 0.5
  if (leafFolds === 0) {
    // No leaves means nothing for a root to be rare RELATIVE to; a root with no
    // leaves at all is the `/compact` path, which is manual by definition.
    return { compliant: true, violations: [] }
  }
  const share = rootFolds / leafFolds
  if (share > maxShare) {
    return {
      compliant: false,
      violations: [{
        rule: 'root-rarity',
        detail: `${rootFolds} root(s) against ${leafFolds} leaf fold(s) is a share of `
          + `${share.toFixed(2)}, above the ${maxShare} maximum; roots are rewriting the frozen `
          + 'prefix faster than leaves accumulate it',
      }],
    }
  }
  return { compliant: true, violations: [] }
}

/** Render a contract report as Markdown for a report. */
export function contractToMarkdown(label: string, report: ContractReport): string {
  if (report.compliant) return `- **${label}**: PASS`
  return [
    `- **${label}**: FAIL`,
    ...report.violations.map(violation => `  - \`${violation.rule}\`: ${violation.detail}`),
  ].join('\n')
}
