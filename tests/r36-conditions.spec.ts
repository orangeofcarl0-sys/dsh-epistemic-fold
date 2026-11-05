/**
 * R36-F: the frozen conditions and gate status are part of the result.
 *
 * A future run must not silently change the prompt, parser, validator, harness,
 * scorer, or dataset and still call itself R36. These tests read the committed
 * conditions and manifests and pin the blocked/ready distinction.
 *
 * @module tests/r36-conditions
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '../eval/r33/src/budget.mjs'

const ROOT = process.cwd()

function readJson(relative: string): any {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
}

describe('R36-F: conditions and gates', () => {
  it('freezes W0 and W1 by digest', () => {
    const conditions = readJson('eval/r36/out/conditions.json')
    expect(conditions.writer.prompts.W0.digest)
      .toBe('1d13166dfaba145986af0d183d1739ed2835aca76668774dada15f0aaf937abc')
    expect(conditions.writer.prompts.W1.digest)
      .toBe('61f380abc4fc2e98a02a55891a9a06c8e41040fbaf845f276ca6bbeadab3b5a3')
    expect(conditions.dataset.digest)
      .toBe('407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f')
    expect(conditions.scorer.version).toBe(3)
  })

  it('keeps every manifest schema-valid and every live phase blocked', () => {
    const conditions = readJson('eval/r36/out/conditions.json')
    const files = [
      'w0-p0-replay.json',
      'w0-p1-replay.json',
      'w1-p0-live.json',
      'w0-p0-live-control.json',
      'h0-o2.json',
      'h-step-o2.json',
      'h-output-o2.json',
      'h-finish-o2.json',
      'h-protocol-o2.json',
      'h-combined-o2.json',
      'h-native-o2.json',
      'b1-s-o1-o2-frozen.json',
    ]
    for (const file of files) {
      const manifest = readJson(`eval/r36/manifests/${file}`)
      const verdict = validateManifest(manifest)
      expect(verdict.ok, verdict.ok ? file : `${file}: ${verdict.reason}`).toBe(true)
      if (manifest.execution === 'live') {
        expect(manifest.requiresAuthorization, file).toBe(true)
        if (file === 'h-native-o2.json') {
          expect(manifest.status, file).toBe('blocked')
        } else {
          expect(manifest.status, file).toBe('executed')
          expect(Array.isArray(manifest.runIds), file).toBe(true)
        }
      } else {
        expect(manifest.status, file).toBe('ready')
      }
    }
    expect(conditions.live.authorization).toBe('granted-in-this-session')
  })

  it('does not claim an executed causal comparison', () => {
    const status = readJson('eval/r36/out/gate-status.json')
    const byId = new Map<string, any>(
      status.gates.map((gate: any) => [gate.id, gate] as [string, any]),
    )
    expect(byId.get('G0').status).toBe('passed')
    expect(byId.get('G1').status).toBe('passed')
    expect(byId.get('G2').status).toBe('passed')
    expect(byId.get('G3').status).toBe('partial')
    expect(byId.get('G4').status).toBe('partial')
    expect(byId.get('G5').status).toBe('insufficient-evidence')
    expect(status.manifestsValid).toBe(true)
    expect(status.authorization).toBe('granted-in-this-session')
  })
})
