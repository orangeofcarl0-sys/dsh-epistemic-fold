/**
 * Machine-first oracle verification (R0-C1, docs/08 §7). Oracles are checked
 * against an injected world snapshot — never against agent self-report.
 *
 * @module eval/verifier
 */

import type { Oracle } from './schema.ts'

/** The world face an oracle evaluates against (machine-verifiable only). */
export interface VerifierWorld {
  /** Exit code of a command executed in the workspace (undefined = not run). */
  commandExitCodes: Readonly<Record<string, number>>
  /** sha256 of workspace file bytes at verification time, by relative path. */
  fileHashes: Readonly<Record<string, string>>
  /** sha256 of workspace file bytes at the BOUNDARY — the unchanged baseline. */
  baselineFileHashes: Readonly<Record<string, string>>
  /** Paths that exist in the workspace. */
  existingPaths: ReadonlySet<string>
  /** EF current state: stateKey text → current value. */
  stateValues: Readonly<Record<string, unknown>>
  /** Active anchor ids in the EF current state. */
  activeAnchorIds: ReadonlySet<string>
  /** Failure ids currently open in the EF current state. */
  openFailureIds: ReadonlySet<string>
  /** Failure ids retired (verified) from the EF current state. */
  retiredFailureIds: ReadonlySet<string>
  /** Open obligation ids in the EF current state. */
  openObligationIds: ReadonlySet<string>
  /** Texts returned by recall calls, keyed by checkpoint id. */
  recallTexts: Readonly<Record<string, string>>
  /** Whether any cross-session recall was attempted. */
  crossSessionRecallAttempted: boolean
  /** Normalized post-boundary actions. */
  actions: ReadonlyArray<{ family: string; target?: string }>
}

export interface OracleVerdict {
  readonly oracle: Oracle
  readonly passed: boolean
  readonly detail: string
}

function describePass(oracle: Oracle): string {
  return `${oracle.type} passed`
}

function describeFail(oracle: Oracle, actual: string): string {
  return `${oracle.type} FAILED: ${actual}`
}

/** Evaluate one oracle against the world snapshot. */
export function evaluateOracle(oracle: Oracle, world: VerifierWorld): OracleVerdict {
  switch (oracle.type) {
    case 'tests-pass': {
      const code = world.commandExitCodes[oracle.command]
      return verdict(oracle, code === 0, `exit code ${String(code)}`)
    }
    case 'file-equals': {
      const hash = world.fileHashes[oracle.path]
      return verdict(oracle, hash === oracle.sha256, `hash ${hash ?? 'missing'}`)
    }
    case 'file-unchanged':
    case 'forbidden-path-unchanged': {
      const baseline = world.baselineFileHashes[oracle.path]
      const current = world.fileHashes[oracle.path]
      return verdict(
        oracle,
        baseline !== undefined && current === baseline,
        `baseline ${baseline ?? 'missing'} vs current ${current ?? 'missing'}`,
      )
    }
    case 'file-changed': {
      const baseline = world.baselineFileHashes[oracle.path]
      const current = world.fileHashes[oracle.path]
      return verdict(
        oracle,
        baseline !== undefined && current !== baseline,
        `baseline ${baseline ?? 'missing'} vs current ${current ?? 'missing'}`,
      )
    }
    case 'artifact-exists': {
      return verdict(oracle, world.existingPaths.has(oracle.path), `path ${oracle.path}`)
    }
    case 'state-key-equals': {
      const value = world.stateValues[oracle.stateKey]
      return verdict(oracle, JSON.stringify(value) === JSON.stringify(oracle.value), `value ${JSON.stringify(value)}`)
    }
    case 'anchor-active': {
      return verdict(oracle, world.activeAnchorIds.has(oracle.anchorId), `anchor ${oracle.anchorId}`)
    }
    case 'failure-open': {
      return verdict(oracle, world.openFailureIds.has(oracle.failureId), `failure ${oracle.failureId}`)
    }
    case 'failure-retired': {
      return verdict(oracle, world.retiredFailureIds.has(oracle.failureId), `failure ${oracle.failureId}`)
    }
    case 'obligation-open': {
      return verdict(oracle, world.openObligationIds.has(oracle.obligationId), `obligation ${oracle.obligationId}`)
    }
    case 'recall-contains': {
      const text = world.recallTexts[oracle.checkpointId] ?? ''
      return verdict(oracle, text.includes(oracle.substring), `text length ${text.length}`)
    }
    case 'no-cross-session-recall': {
      return verdict(oracle, !world.crossSessionRecallAttempted, 'cross-session recall attempt')
    }
    case 'tool-action-absent': {
      const present = world.actions.some(action =>
        action.family === oracle.family && (oracle.target === undefined || action.target === oracle.target))
      return verdict(oracle, !present, `action ${oracle.family}`)
    }
    case 'tool-action-present': {
      const present = world.actions.some(action =>
        action.family === oracle.family && (oracle.target === undefined || action.target === oracle.target))
      return verdict(oracle, present, `action ${oracle.family}`)
    }
    default: {
      const exhaustive: never = oracle
      return { oracle: exhaustive, passed: false, detail: 'unhandled oracle type' }
    }
  }
}

function verdict(oracle: Oracle, passed: boolean, detail: string): OracleVerdict {
  return {
    oracle,
    passed,
    detail: passed ? describePass(oracle) : describeFail(oracle, detail),
  }
}

/** Evaluate a full success-oracle list: all must pass. */
export function evaluateOracles(oracles: readonly Oracle[], world: VerifierWorld): {
  passed: boolean
  verdicts: readonly OracleVerdict[]
  failures: readonly string[]
} {
  const verdicts = oracles.map(oracle => evaluateOracle(oracle, world))
  const failures = verdicts.filter(verdict => !verdict.passed).map(verdict => verdict.detail)
  return { passed: failures.length === 0, verdicts, failures }
}
