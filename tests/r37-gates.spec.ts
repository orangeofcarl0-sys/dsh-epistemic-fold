/**
 * R37-A6: the gate report is computed from artifacts and does not turn a
 * blocked live phase into a pass.
 *
 * @module tests/r37-gates
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const status: any = JSON.parse(readFileSync(
  join(ROOT, 'eval', 'r37', 'out', 'gate-status.json'),
  'utf8',
))

function gate(id: string): any {
  return status.gates.find((entry: any) => entry.id === id)
}

describe('R37-A6: gates', () => {
  it('passes the offline evidence gates', () => {
    for (const id of ['G0', 'G1', 'G2', 'G3', 'G4']) {
      expect(gate(id).status).toBe('passed')
    }
  })

  it('does not mark the live phase passed or failed', () => {
    expect(gate('G5').status).toBe('ready-not-authorized')
    expect(status.liveExecution.executed).toBe(false)
    expect(status.liveExecution.status).toBe('not-executed')
    expect(status.liveExecution.hNative).toBe('blocked')
    expect(status.authorization.r37b).toBe('not-granted')
  })

  it('records the product decision as insufficient evidence', () => {
    expect(gate('G6').status).toBe('insufficient-evidence')
    expect(gate('G6').detail).toMatch(/insufficient evidence/u)
  })

  it('names the authoritative artifacts', () => {
    expect(status.artifacts.reconstruction).toBe('eval/r37/out/r36-evidence-reconstruction.json')
    expect(status.artifacts.protocol).toBe('eval/r37/out/protocol-ablation.json')
    expect(status.artifacts.benchmarkValidity).toBe('eval/r37/out/benchmark-validity.json')
    expect(status.artifacts.forensics).toBe('eval/r37/out/forensics.json')
    expect(status.artifacts.preregistration).toBe('docs/semantic-continuity/R37_B_PREREGISTRATION.md')
  })
})
