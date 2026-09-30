/**
 * The frozen acceptance set's selection rule.
 *
 * `bench/ef-selectbench-v1.json` names which external benchmark tasks the EF
 * arms will be measured on. The rule that produced it — select on the ROUTE
 * MODEL's reward band, not the cross-model mean — was learned the hard way:
 * `duckdb-optimizer-closure` has an attractive cross-model mean of 0.512 and is
 * nonetheless worthless to us, because our route scores 1.00 on it.
 *
 * A task that is already solved cannot separate the arms. A task nobody solves
 * cannot either. So the band is a *mechanical* admission criterion, and these
 * tests enforce it rather than trusting whoever edits the manifest next.
 *
 * @module tests/selectbench-manifest
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Cell {
  readonly id?: string
  readonly domain?: string
  readonly role?: 'discriminator' | 'anchor'
  readonly rewardOurRoute?: number
  readonly resources?: { readonly cpus: number; readonly memoryMb: number; readonly storageMb: number }
  readonly efDiscrimination: string
  readonly hostVerdict?: string
  readonly exclusionReason?: string
  readonly anchorReason?: string
}

interface Manifest {
  readonly schema: string
  readonly route: { readonly model: string }
  readonly lanes: Record<string, {
    readonly benchmark: string
    readonly cells: readonly Cell[]
    readonly hostFeasibility: string
  }>
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'bench', 'ef-selectbench-v1.json'), 'utf8'),
)

/** A task is admissible only inside this band, for the route model. */
const SATURATED = 0.85
const FLOOR = 0.15

describe('EF-SelectBench v1 is frozen and internally consistent', () => {
  it('declares its schema and the route it was selected for', () => {
    expect(manifest.schema).toBe('ef-selectbench/1')
    // Selection is route-conditioned, so the manifest is meaningless without
    // naming the route it was conditioned on.
    expect(manifest.route.model).toBe('deepseek-v4.1-flash')
  })

  it('has the three lanes, and does not pool them', () => {
    expect(Object.keys(manifest.lanes).sort()).toEqual(['interaction', 'longwork', 'memory'])
    for (const [name, lane] of Object.entries(manifest.lanes)) {
      expect(lane.benchmark.length, `${name} must name its benchmark`).toBeGreaterThan(0)
      expect(lane.hostFeasibility.length, `${name} must state host feasibility`).toBeGreaterThan(0)
      expect(lane.cells.length, `${name} must have cells`).toBeGreaterThan(0)
    }
  })

  it('states a discrimination rationale for every cell', () => {
    for (const [lane, value] of Object.entries(manifest.lanes)) {
      for (const cell of value.cells) {
        const label = cell.id ?? `${cell.domain}/${String(cell.id)}`
        expect(cell.efDiscrimination.length, `${lane}/${label} needs a rationale`)
          .toBeGreaterThan(20)
      }
    }
  })

  it('admits no LHTB DISCRIMINATOR that is saturated or floored FOR OUR ROUTE', () => {
    // This is the rule the first plan violated. A task outside the band may
    // still be carried as an ANCHOR — a task our route usually solves, useful
    // for catching a regression — but it must say so, and it cannot be counted
    // as evidence of improvement.
    let discriminators = 0
    for (const cell of manifest.lanes.longwork!.cells) {
      const label = String(cell.id)
      if (cell.hostVerdict?.startsWith('EXCLUDED')) {
        expect(cell.exclusionReason, `${label} is excluded and must say why`).toBeDefined()
        continue
      }
      const reward = cell.rewardOurRoute
      expect(reward, `${label} must state its route reward`).toBeDefined()
      if (cell.role === 'anchor') {
        expect(cell.anchorReason, `${label} is an anchor and must say why`).toBeDefined()
        // An anchor is admitted only because it is OUT of band; if it were in
        // band it should be a discriminator, and the label would be misleading.
        expect(
          reward! > SATURATED || reward! < FLOOR,
          `${label} is labelled anchor but sits inside the discriminator band`,
        ).toBe(true)
        continue
      }
      expect(cell.role, `${label} must declare a role`).toBe('discriminator')
      expect(reward, `${label}: ${reward} is saturated for our route`).toBeLessThanOrEqual(SATURATED)
      expect(reward, `${label}: ${reward} is floored for our route`).toBeGreaterThanOrEqual(FLOOR)
      discriminators += 1
    }
    // The lane is worthless without at least one task that can move in either
    // direction; anchors alone can only detect breakage.
    expect(discriminators, 'the longwork lane needs at least one discriminator').toBeGreaterThan(0)
  })

  it('records the saturation exclusion that the first plan got wrong', () => {
    // Pinned because this specific error is the one that cost the most time:
    // it looked discriminating by cross-model mean and is solved every time by
    // the model we actually run.
    const duckdb = manifest.lanes.longwork!.cells.find(cell => cell.id === 'duckdb-optimizer-closure')
    expect(duckdb, 'duckdb-optimizer-closure must stay documented').toBeDefined()
    expect(duckdb!.rewardOurRoute).toBe(1.0)
    expect(duckdb!.hostVerdict).toBe('EXCLUDED for our route')
  })

  it('states CPU/RAM/storage for every LHTB cell, since that is what blocks the lane', () => {
    for (const cell of manifest.lanes.longwork!.cells) {
      expect(cell.resources, `${String(cell.id)} must declare resources`).toBeDefined()
      expect(cell.resources!.memoryMb).toBeGreaterThan(0)
      expect(cell.resources!.cpus).toBeGreaterThan(0)
    }
  })

  it('records host feasibility for every lane rather than assuming it', () => {
    // Two of the three lanes are blocked on this machine. Recording that is the
    // difference between a plan and a wish.
    expect(manifest.lanes.longwork!.hostFeasibility).toMatch(/BLOCKED/i)
    expect(manifest.lanes.memory!.hostFeasibility).toMatch(/BLOCKED/i)
    expect(manifest.lanes.interaction!.hostFeasibility).toMatch(/FEASIBLE/i)
  })

  it('keeps every cited id unique within its lane', () => {
    for (const [lane, value] of Object.entries(manifest.lanes)) {
      const ids = value.cells.map(cell =>
        lane === 'interaction' ? `${cell.domain}/${String(cell.id)}` : String(cell.id))
      expect(new Set(ids).size, `${lane} has a duplicate cell id`).toBe(ids.length)
    }
  })
})
