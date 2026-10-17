/**
 * `FoldTelemetry` (docs/68 B-1), the record that replaced fourteen mutable fields and their
 * fourteen getters on `EpistemicFoldEngine`.
 *
 * The unit is small enough to pin directly, which is the point of extracting it: the counters
 * used to be observable only by driving a whole engine through a fold.
 *
 * @module tests/fold-telemetry
 */

import { describe, expect, it } from "vitest"
import { createFoldTelemetry, recordFold } from "../src/fold/fold-telemetry.ts"

describe("the telemetry record", () => {
  it("starts with every counter zero and every last-observed value unset", () => {
    const t = createFoldTelemetry()
    expect(t.rootFolds).toBe(0)
    expect(t.leafFolds).toBe(0)
    expect(t.emergencyRebases).toBe(0)
    expect(t.bundleWrites).toBe(0)
    expect(t.derivedAnswersRetired).toBe(0)
    expect(t.thresholdTokens).toBe(0)
    for (const key of ["compactSpec", "leafAdmission", "rebaseDecision", "pressureRegime",
      "postLeafRegime", "capacityRegime", "foldReachability", "rootRebaseAdvice"] as const) {
      expect(t[key], key + " must start unset").toBeUndefined()
    }
  })

  it("counts each fold kind in exactly its own counter", () => {
    // The mapping used to be a three-case switch inside the fold-commit path, which is where a
    // missing case is hardest to notice. This is the assertion that switch could not have.
    const t = createFoldTelemetry()
    recordFold(t, "leaf")
    recordFold(t, "leaf")
    recordFold(t, "root")
    recordFold(t, "emergency")
    expect(t.leafFolds).toBe(2)
    expect(t.rootFolds).toBe(1)
    expect(t.emergencyRebases).toBe(1)
  })

  it("returns a fresh record each time, so two engines cannot share counters", () => {
    const a = createFoldTelemetry()
    const b = createFoldTelemetry()
    recordFold(a, "leaf")
    expect(a.leafFolds).toBe(1)
    expect(b.leafFolds).toBe(0)
  })
})
