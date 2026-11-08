/**
 * EF-C0 WP4 — the evidence registry must stay honest.
 *
 * These tests re-hash every registered artifact and check the properties the
 * brief cares about most: no mechanism result is promoted to product evidence,
 * the historical B1 arm is not treated as Native DSH Basic, and the repository
 * ancestry is what the stage map says.
 *
 * @module tests/convergence-evidence
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA = join(ROOT, 'docs', 'convergence', 'data')

interface EvidenceClaim {
  readonly claimId: string
  readonly rawArtifact: string
  readonly artifactSha256: string
  readonly artifactPresent: boolean
  readonly evidenceLevel: string
  readonly limitations: string
  readonly model: string
  readonly route: string
  readonly harness: string
  readonly datasetVersion: string
  readonly scorerVersion: string
}

interface EvidenceRegistry {
  readonly claims: readonly EvidenceClaim[]
  readonly counts: { readonly missingArtifacts: number }
}

interface Arm {
  readonly arm: string
  readonly status: string
}

interface Baseline {
  readonly arms: readonly Arm[]
  readonly comparability: {
    readonly historicalB1IsNotB0: boolean
    readonly mechanismIsNotBehavior: boolean
  }
}

interface StageMap {
  readonly head: { readonly sha: string }
  readonly ancestry: {
    readonly checks: readonly { readonly ancestor: boolean }[]
    readonly mainToR38: { readonly ahead: number; readonly behind: number }
  }
  readonly refsWithoutRemote: readonly string[]
}

interface Manifest {
  readonly externalArchive: {
    readonly path: string
    readonly expectedSha256: string
    readonly expectedBytes: number
    readonly available?: boolean
    readonly match: boolean
  }
  readonly historicalDigests: {
    readonly allMatch: boolean
    readonly checks: readonly { readonly path: string; readonly match: boolean }[]
  }
}

const registry = JSON.parse(readFileSync(join(DATA, 'evidence-registry.json'), 'utf8')) as EvidenceRegistry
const baseline = JSON.parse(readFileSync(join(DATA, 'baseline-comparison-manifest.json'), 'utf8')) as Baseline
const stageMap = JSON.parse(readFileSync(join(DATA, 'git-stage-map.json'), 'utf8')) as StageMap
const manifest = JSON.parse(readFileSync(join(DATA, 'artifact-manifest.json'), 'utf8')) as Manifest

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('EF-C0 evidence: registry integrity', () => {
  it('every claim has a present, unchanged artifact', () => {
    expect(registry.claims.length).toBeGreaterThanOrEqual(18)
    for (const claim of registry.claims) {
      const full = join(ROOT, claim.rawArtifact)
      expect(existsSync(full), `${claim.claimId} artifact missing: ${claim.rawArtifact}`).toBe(true)
      expect(sha256(full), `${claim.claimId} artifact changed: ${claim.rawArtifact}`).toBe(claim.artifactSha256)
      expect(claim.artifactPresent).toBe(true)
    }
    expect(registry.counts.missingArtifacts).toBe(0)
  })

  it('no mechanism result is labelled Product-level Evidence', () => {
    const product = registry.claims.filter(claim => claim.evidenceLevel === 'Product-level Evidence')
    // Today there are zero product-level claims. If one is added later, it must
    // carry the frozen metadata a product claim requires — not just a new label.
    for (const claim of product) {
      for (const field of ['model', 'route', 'harness', 'datasetVersion', 'scorerVersion']) {
        const value = (claim as unknown as Record<string, unknown>)[field]
        expect(value, `${claim.claimId}.${field} must not be Unknown`).not.toBe('Unknown')
        expect(String(value).length).toBeGreaterThan(0)
      }
    }
    expect(product.length).toBe(0)
  })

  it('R37-B stays a behavioral observation, not a product result', () => {
    const claim = registry.claims.find(row => row.claimId === 'R37B-CONTRACT-HARM')!
    expect(claim.evidenceLevel).toBe('Behavioral Observation')
    expect(claim.limitations).toContain('B1 is NOT Native DSH Basic')
  })

  it('the historical B1 arm is explicitly not B0', () => {
    const b1 = baseline.arms.find(arm => arm.arm === 'B1-HISTORICAL')!
    expect(b1).toBeDefined()
    expect(b1.status).toContain('NOT equivalent to B0')
    expect(baseline.comparability.historicalB1IsNotB0).toBe(true)
    expect(baseline.comparability.mechanismIsNotBehavior).toBe(true)
  })
})

describe('EF-C0 evidence: repository facts', () => {
  it('every stage in the chain is an ancestor of the next', () => {
    expect(stageMap.ancestry.checks.length).toBeGreaterThan(0)
    expect(stageMap.ancestry.checks.every(row => row.ancestor === true)).toBe(true)
    expect(stageMap.ancestry.mainToR38).toEqual({ ahead: 96, behind: 0 })
  })

  it('three stages have commits but no remote ref', () => {
    expect([...stageMap.refsWithoutRemote].sort()).toEqual([
      'rc36-semantic-interface',
      'rc37c-measurement-closure',
      'rc37d-operational-completion',
    ])
  })

  it('the R37-B archive identity matches when the archive is available', () => {
    const archive = manifest.externalArchive
    expect(archive.expectedSha256).toBe('de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92')
    expect(archive.expectedBytes).toBe(3_763_962)
    if (archive.available === false) return
    expect(existsSync(archive.path)).toBe(true)
    expect(sha256(archive.path)).toBe(archive.expectedSha256)
    expect(archive.match).toBe(true)
  })

  it('the six historical result digests still match', () => {
    expect(manifest.historicalDigests.allMatch).toBe(true)
    for (const check of manifest.historicalDigests.checks) {
      expect(check.match, check.path).toBe(true)
    }
  })
})
