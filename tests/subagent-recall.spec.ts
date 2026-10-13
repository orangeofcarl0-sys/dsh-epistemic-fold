/**
 * Subagent recall (docs/67), pinned at the seams that can be pinned without a provider.
 *
 * The loop is pure logic over injected callbacks — a fetch, a search, and ONE model call —
 * so every branch that decides what the caller receives is reachable here. The parts that
 * cannot be tested without a live model are the PROMPTS, and they are asserted by shape
 * (what the planner is shown, what the answer call is given) rather than by output.
 *
 * @module tests/subagent-recall
 */

import { describe, expect, it, beforeEach } from "vitest"
import type { Message } from "@deepseek-ai/dsh-llm"
import {
  CHARS_PER_TOKEN_ESTIMATE,
  describeCheckpoint,
  jsonChars,
  extractJsonObject,
  fallbackPlan,
  gateRecallPayload,
  inventoryOf,
  parseAnswer,
  parsePlan,
  recallBudgetVerdict,
  resetSubagentRecallStats,
  runSubagentRecall,
  subagentRecallStats,
  SUBAGENT_MAX_FETCHES,
} from "../src/subagent-recall.ts"
import type { CheckpointDescriptor, SubagentMessage } from "../src/subagent-recall.ts"
import { isDerivedAnswer, isRetiredDerived, retireDerivedAnswers } from "../src/subagent-recall.ts"
import type { CheckpointBundleV1 } from "../src/types.ts"

function textMessage(role: Message["role"], text: string): Message {
  return { role, content: [{ type: "text", text }] } as unknown as Message
}

function bundleWith(messages: Message[], id = "cp:test"): CheckpointBundleV1 {
  return {
    checkpointId: id,
    mode: "leaf",
    createdAt: 0,
    source: { orderedSurfaceSeqs: [2, 6], sourceDigest: "d" },
    archive: { logicalHash: "h", messageCount: messages.length, refs: [], shadowedMessages: messages },
    rendered: { digest: "r", text: "[EF1 L " + id + "]" },
  } as unknown as CheckpointBundleV1
}

const DESC: CheckpointDescriptor = {
  handle: "cp:a",
  mode: "leaf",
  span: { first: 2, last: 40 },
  messageCount: 6,
  inventory: ["user: do the thing"],
}

beforeEach(() => resetSubagentRecallStats())

describe("the direct-recall size gate", () => {
  it("allows a recall at or under the threshold and refuses one over it", () => {
    expect(recallBudgetVerdict(100, 100).allowed).toBe(true)
    expect(recallBudgetVerdict(99, 100).allowed).toBe(true)
    const over = recallBudgetVerdict(101, 100)
    expect(over.allowed).toBe(false)
    expect(over.overBy).toBe(1)
    expect(over.projectedChars).toBe(101)
    expect(over.thresholdChars).toBe(100)
  })

  it("prices the refusal in tokens, and labels it as the estimate it is", () => {
    // The caller is shown a token figure because that is the unit its own budget is in, and
    // the constant is exported so the test can state the arithmetic rather than repeat it.
    const verdict = recallBudgetVerdict(CHARS_PER_TOKEN_ESTIMATE * 10, 1)
    expect(verdict.estimatedTokens).toBe(10)
  })

  it("measures what would actually be RENDERED, not an approximation of it", () => {
    expect(jsonChars({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
    expect(jsonChars(undefined)).toBe(0)
    // A value that cannot be serialized must not throw inside a tool call.
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    expect(jsonChars(circular)).toBe(0)
  })

  it("owns the refusal payload, so the policy is testable without registering a tool", async () => {
    // B-3: the decision and the payload used to live in tools.ts, apart from the verdict
    // function they rest on. They are one function now, and this pins the shape the tool
    // returns — including the key ORDER, which is part of the bytes a caller sees.
    let described = 0
    const wiring = { thresholdChars: 10, fetchBudgetChars: 1 }
    expect(await gateRecallPayload({ text: "short" }, "cp:a", { thresholdChars: 1_000, fetchBudgetChars: 1 },
      async () => { described += 1; return DESC })).toBeNull()
    expect(described, "an allowed recall never pays for the descriptor").toBe(0)
    expect(subagentRecallStats.gated).toBe(0)

    const payload = { text: "x".repeat(5000) }
    const refusal = await gateRecallPayload(payload, "cp:big", wiring, async () => DESC) as Record<string, unknown>
    expect(subagentRecallStats.gated).toBe(1)
    expect(Object.keys(refusal)).toEqual([
      "checkpointId", "overBudget", "projectedChars", "estimatedTokens",
      "thresholdChars", "overBy", "descriptor", "suggestion", "alternatives",
    ])
    expect(refusal["checkpointId"]).toBe("cp:big")
    expect(refusal["overBudget"]).toBe(true)
    expect(refusal["projectedChars"]).toBe(jsonChars(payload))
    expect(refusal["estimatedTokens"]).toBe(Math.ceil(jsonChars(payload) / CHARS_PER_TOKEN_ESTIMATE))
    expect(refusal["overBy"]).toBe(jsonChars(payload) - wiring.thresholdChars)
    expect(refusal["descriptor"]).toEqual(DESC)
    expect(refusal["suggestion"]).toContain("over the 10-character direct limit")
    expect(refusal["alternatives"]).toEqual([
      "context_recall with a smaller limit returns one page",
      "context_recall_subagent with no goal returns a survey of what the archive holds",
    ])
  })
})

describe("the deterministic descriptor", () => {
  it("describes what a checkpoint holds, in role and tool terms", () => {
    const messages = [
      textMessage("user", "You must repair the engine"),
      textMessage("assistant", "Reading the daemon"),
      textMessage("tool", "total 100 drwxrwxrwx 1 root root 4096 ."),
    ]
    const inventory = inventoryOf(messages)
    expect(inventory[0]).toContain("user: You must repair the engine")
    expect(inventory[1]).toContain("assistant: Reading the daemon")
    expect(inventory[2]).toContain("tool:")
  })

  it("names the tool a message called, which is what tells a read from a task statement", () => {
    const call: Message = {
      role: "assistant",
      content: [{ type: "tool-call", id: "1", name: "run_shell", arguments: "{\"command\":\"cat engine.py\"}" }],
    } as unknown as Message
    const inventory = inventoryOf([call])
    expect(inventory[0]).toContain("assistant -> run_shell")
    expect(inventory[0]).toContain("cat engine.py")
  })

  it("summarises the tail instead of listing an unbounded inventory", () => {
    const many = Array.from({ length: 15 }, (_, i) => textMessage("tool", "line " + i))
    const inventory = inventoryOf(many, 10)
    expect(inventory).toHaveLength(11)
    expect(inventory[10]).toContain("5 more message(s)")
  })

  it("distinguishes an unreadable archive from an empty one", () => {
    // These are different claims and a caller acting on the wrong one reports a fact as
    // unknown. A referential archive with no resolvable source is the real case.
    const referential = {
      checkpointId: "cp:r",
      mode: "leaf",
      createdAt: 0,
      source: { orderedSurfaceSeqs: [], sourceDigest: "d" },
      archive: { logicalHash: "h", messageCount: 4, refs: [{ seq: 2, digest: "x" }] },
      rendered: { digest: "r", text: "[EF1 L cp:r]" },
    } as unknown as CheckpointBundleV1
    const descriptor = describeCheckpoint(referential)
    expect(descriptor.inventory[0]).toContain("archive unreadable")
    expect(descriptor.messageCount).toBe(4)
    expect(descriptor.span).toBeUndefined()
  })

  it("carries the span a fold recorded, so the planner has a position to reason about", () => {
    const descriptor = describeCheckpoint(bundleWith([textMessage("user", "hi")]))
    expect(descriptor.handle).toBe("cp:test")
    expect(descriptor.span).toEqual({ first: 2, last: 6 })
    expect(descriptor.inventory[0]).toContain("hi")
  })
})

describe("the plan protocol", () => {
  it("reads a plan out of prose and code fences", () => {
    const reply = "Sure!\n```json\n{\"queries\":[\"disk units\"],\"fetches\":[{\"ref\":\"cp:a\",\"depth\":\"exact\",\"offset\":5}]}\n```\ndone"
    const plan = parsePlan(reply)
    expect(plan).not.toBeNull()
    expect(plan!.queries).toEqual(["disk units"])
    expect(plan!.fetches).toEqual([{ ref: "cp:a", depth: "exact", offset: 5 }])
  })

  it("defaults an unknown depth to exact rather than dropping the fetch", () => {
    const plan = parsePlan("{\"fetches\":[{\"ref\":\"cp:a\",\"depth\":\"everything\"}]}")
    expect(plan!.fetches[0]!.depth).toBe("exact")
  })

  it("refuses a reply with no usable plan, so the caller can fall back deterministically", () => {
    expect(parsePlan("I will have a look.")).toBeNull()
    expect(parsePlan("{\"fetches\":[],\"queries\":[]}")).toBeNull()
    expect(parsePlan("{\"fetches\":[{\"ref\":\"\"}]}")).toBeNull()
    expect(parsePlan("{\"fetches\":\"cp:a\"}")).toBeNull()
    expect(extractJsonObject("no braces here")).toBeNull()
    expect(extractJsonObject("{ not json }")).toBeNull()
  })

  it("falls back to what the caller already named", () => {
    const base = {
      descriptors: [DESC],
      fetch: async () => null,
      search: async () => ({ text: "", chars: 0 }),
      complete: async () => "",
    }
    expect(fallbackPlan({ ...base, ref: "cp:z" }, 6).fetches).toEqual([{ ref: "cp:z", depth: "exact", offset: 0 }])
    expect(fallbackPlan({ ...base, query: "units" }, 6).queries).toEqual(["units"])
    expect(fallbackPlan(base, 6).fetches).toEqual([{ ref: "cp:a", depth: "summary" }])
    expect(fallbackPlan({ ...base, descriptors: [] }, 6).fetches).toEqual([])
  })
})

describe("the answer protocol", () => {
  it("separates the answer from the quotes and the non-goal list", () => {
    const reply = JSON.stringify({
      answer: "disk uses decimal gb",
      quotes: ["disk_mb: decimal gb with gib/tib"],
      further: [{ question: "what are the aliases?", why: "stage A grades them" }],
    })
    const parsed = parseAnswer(reply)
    expect(parsed.answer).toBe("disk uses decimal gb")
    expect(parsed.quotes).toEqual(["disk_mb: decimal gb with gib/tib"])
    expect(parsed.further[0]!.question).toBe("what are the aliases?")
  })

  it("keeps the raw reply when the subagent did not follow the shape", () => {
    // An empty answer would be a silent failure; the raw text at least says what happened.
    expect(parseAnswer("the archive does not answer that").answer).toBe("the archive does not answer that")
    expect(parseAnswer("{\"quotes\":[\"x\"]}").answer).toBe("{\"quotes\":[\"x\"]}")
    expect(parseAnswer("{\"answer\":\"\"}").quotes).toEqual([])
  })

  it("drops malformed further entries rather than inventing questions", () => {
    const parsed = parseAnswer(JSON.stringify({ answer: "a", further: [{ why: "no question" }, { question: "q", why: 7 }] }))
    expect(parsed.further).toEqual([{ question: "q", why: "" }])
  })
})

describe("the bounded loop", () => {
  it("plans, reads, and answers — and returns the non-goal list with it", async () => {
    const seen: SubagentMessage[][] = []
    const answer = await runSubagentRecall({
      goal: "what unit is disk_mb in?",
      descriptors: [DESC],
      fetch: async () => ({ text: "disk_mb is decimal gb", chars: 22 }),
      search: async () => ({ text: "{\"hits\":[]}", chars: 12 }),
      complete: async messages => {
        seen.push([...messages])
        if (seen.length === 1) return "{\"fetches\":[{\"ref\":\"cp:a\",\"depth\":\"exact\"}]}"
        return JSON.stringify({
          answer: "decimal gb",
          quotes: ["disk_mb is decimal gb"],
          further: [{ question: "what about memory_mb?", why: "the other family" }],
        })
      },
    })
    expect(answer.mode).toBe("goal")
    expect(answer.answer).toBe("decimal gb")
    expect(answer.quotes).toEqual(["disk_mb is decimal gb"])
    expect(answer.further).toHaveLength(1)
    expect(answer.used.refs).toEqual(["cp:a"])
    expect(answer.used.fetchedChars).toBe(22)
    expect(answer.used.truncated).toBe(false)
    // The planner sees the DESCRIPTOR, never the archive: that is what makes the choice cheap.
    expect(seen[0]!.map(m => m.text).join("\n")).toContain("cp:a")
    expect(seen[0]!.map(m => m.text).join("\n")).toContain("do the thing")
    // The answer call sees the MATERIAL and the goal.
    expect(seen[1]!.map(m => m.text).join("\n")).toContain("disk_mb is decimal gb")
    expect(seen[1]!.map(m => m.text).join("\n")).toContain("what unit is disk_mb in?")
  })

  it("surveys when there is no goal, and says so", async () => {
    const answer = await runSubagentRecall({
      descriptors: [DESC],
      fetch: async () => ({ text: "x", chars: 1 }),
      search: async () => ({ text: "y", chars: 1 }),
      complete: async () => JSON.stringify({ answer: "this archive holds the task statement", further: [{ question: "read it?", why: "it is the goal" }] }),
    })
    expect(answer.mode).toBe("survey")
    expect(subagentRecallStats.surveyInvocations).toBe(1)
    // A survey is the NON-GOAL face: what is here, and what to ask next.
    expect(answer.further).toHaveLength(1)
  })

  it("stops reading at the fetch budget and REPORTS that it did", async () => {
    let planCalls = 0
    const answer = await runSubagentRecall({
      goal: "g",
      descriptors: [DESC, { ...DESC, handle: "cp:b" }, { ...DESC, handle: "cp:c" }],
      fetchBudgetChars: 10,
      fetch: async () => ({ text: "0123456789", chars: 10 }),
      search: async () => ({ text: "", chars: 0 }),
      // The discriminator is a CALL COUNTER, not the message count: both prompts are two
      // messages (system + user), so a length test inverts the protocol silently.
      complete: async () => { planCalls += 1; return planCalls === 1
        ? "{\"fetches\":[{\"ref\":\"cp:a\"},{\"ref\":\"cp:b\"},{\"ref\":\"cp:c\"}]}"
        : "{\"answer\":\"partial\"}" },
    })
    expect(answer.used.truncated).toBe(true)
    expect(answer.used.fetchedChars).toBeLessThanOrEqual(10)
    // One read fitted; the second would have exceeded the budget, so it was not made.
    expect(answer.used.refs).toHaveLength(3)
  })

  it("caps the number of reads whatever the plan asks for", async () => {
    let reads = 0
    let planCalls = 0
    const many = Array.from({ length: SUBAGENT_MAX_FETCHES + 4 }, (_, i) => ({ ...DESC, handle: "cp:" + i }))
    const answer = await runSubagentRecall({
      goal: "g",
      descriptors: many,
      fetchBudgetChars: 1_000_000,
      fetch: async () => { reads += 1; return { text: "x", chars: 1 } },
      search: async () => ({ text: "", chars: 0 }),
      complete: async () => { planCalls += 1; return planCalls === 1
        ? JSON.stringify({ fetches: many.map(d => ({ ref: d.handle, depth: "summary" })) })
        : "{\"answer\":\"ok\"}" },
    })
    expect(reads).toBe(SUBAGENT_MAX_FETCHES)
    expect(answer.used.truncated).toBe(true)
  })

  it("uses the deterministic fallback when the model produces no plan", async () => {
    const refs: string[] = []
    let planCalls = 0
    const answer = await runSubagentRecall({
      goal: "g",
      ref: "cp:named",
      descriptors: [DESC],
      fetch: async request => { refs.push(request.ref); return { text: "material", chars: 8 } },
      search: async () => ({ text: "", chars: 0 }),
      complete: async () => { planCalls += 1; return planCalls === 1
        ? "I am not going to answer that."
        : "{\"answer\":\"fallback worked\"}" },
    })
    expect(refs).toEqual(["cp:named"])
    expect(answer.answer).toBe("fallback worked")
  })

  it("records a failed model call and still returns something the caller can act on", async () => {
    // A retrieval helper that can end an episode is worse than one that reports it could not
    // help: the caller keeps its turn and can fall back to context_recall.
    const answer = await runSubagentRecall({
      goal: "g",
      descriptors: [DESC],
      fetch: async () => ({ text: "material", chars: 8 }),
      search: async () => ({ text: "", chars: 0 }),
      complete: async () => { throw new Error("provider down") },
    })
    expect(answer.answer).toContain("provider down")
    expect(subagentRecallStats.failures).toBeGreaterThan(0)
    expect(subagentRecallStats.lastError).toBe("provider down")
  })

  it("counts what it did, because an experiment that cannot be read is not an experiment", async () => {
    let planCalls = 0
    await runSubagentRecall({
      goal: "g",
      descriptors: [DESC],
      fetch: async () => ({ text: "abc", chars: 3 }),
      search: async () => ({ text: "de", chars: 2 }),
      complete: async () => { planCalls += 1; return planCalls === 1
        ? "{\"queries\":[\"q\"],\"fetches\":[{\"ref\":\"cp:a\"}]}"
        : "{\"answer\":\"answer text\"}" },
    })
    expect(subagentRecallStats.invocations).toBe(1)
    expect(subagentRecallStats.planCalls).toBe(1)
    expect(subagentRecallStats.answerCalls).toBe(1)
    expect(subagentRecallStats.fetches).toBe(2)
    expect(subagentRecallStats.fetchedChars).toBe(5)
    expect(subagentRecallStats.answerChars).toBe("answer text".length)
  })
})
describe("derived provenance, which is what stops a paraphrase becoming a source", () => {
  it("marks every answer as derived and names what it was derived from", async () => {
    // The answer lands on the caller surface as an ordinary `tool/result`, and
    // `tool/result` is an AUTHORITATIVE kind. Without this mark the fold policy can archive
    // a paraphrase into the main tree and a later reader cannot tell it from history.
    let planCalls = 0
    const answer = await runSubagentRecall({
      goal: "g",
      descriptors: [DESC],
      fetch: async () => ({ text: "raw material", chars: 12 }),
      search: async () => ({ text: "hits", chars: 4 }),
      complete: async () => { planCalls += 1; return planCalls === 1
        ? "{\"queries\":[\"q\"],\"fetches\":[{\"ref\":\"cp:a\"}]}"
        : "{\"answer\":\"a paraphrase\"}" },
    })
    expect(answer.efDerived.by).toBe("retrieval-subagent")
    expect(answer.efDerived.refs).toEqual(["cp:a", "search:q"])
    expect(answer.efDerived.reads).toBe(2)
    expect(answer.efDerived.fetchedChars).toBe(16)
    expect(answer.efDerived.truncated).toBe(false)
  })

  it("survives the JSON round-trip the archive stores, so detection is a substring test", async () => {
    const answer = await runSubagentRecall({
      goal: "g",
      descriptors: [DESC],
      fetch: async () => ({ text: "x", chars: 1 }),
      search: async () => ({ text: "", chars: 0 }),
      complete: async () => "{\"answer\":\"short\"}",
    })
    // This is exactly what the tool returns, and therefore exactly what gets archived.
    const rendered = JSON.stringify(answer, null, 2)
    expect(isDerivedAnswer(rendered)).toBe(true)
    expect(rendered).toContain("efDerived")
  })

  it("labels a derived answer in the descriptor instead of presenting it as history", () => {
    const derived = textMessage("tool", JSON.stringify({ efDerived: { by: "retrieval-subagent" }, answer: "a paraphrase" }))
    const inventory = inventoryOf([derived, textMessage("tool", "total 100 -rw-r--r-- engine.py")])
    expect(inventory[0]).toContain("DERIVED ANSWER (retrieval subagent)")
    expect(inventory[0]).toContain("not raw history")
    // Raw material is still described by its role, so the two are distinguishable at a
    // glance — which is the whole point of the label.
    expect(inventory[1]).toContain("tool:")
    expect(inventory[1]).not.toContain("DERIVED")
  })

  it("does not mistake ordinary text for a derived answer", () => {
    expect(isDerivedAnswer("the archive says disk is decimal gb")).toBe(false)
    expect(inventoryOf([textMessage("tool", "plain output")])[0]).not.toContain("DERIVED")
  })
})
describe("retirement at the fold, which is what keeps a paraphrase out of the next round", () => {
  it("retires the content of a derived answer and leaves everything else alone", () => {
    // The paraphrase must not enter the next round. It is regenerable, so retiring it costs
    // nothing that cannot be re-obtained from raw checkpoints that ARE archived.
    // A distinctive body, because the tombstone itself legitimately uses the words
    // "paraphrase" and "regenerable" -- an assertion on those words would test the prose.
    const derived = textMessage("tool", JSON.stringify({ efDerived: { by: "retrieval-subagent" }, answer: "ANSWER-BODY-SHOULD-BE-GONE" }))
    const raw = textMessage("tool", "total 100 -rw-r--r-- engine.py")
    const result = retireDerivedAnswers([raw, derived])
    expect(result.retired).toBe(1)
    expect(result.messages).toHaveLength(2)
    // Length is preserved on purpose: `currentSpanSeqs` THROWS when the archived count
    // disagrees with the span, and that throw ends the episode.
    expect(result.messages[0]).toBe(raw)
    const retired = JSON.stringify(result.messages[1]!.content)
    expect(retired).toContain("efDerivedRetired")
    expect(retired).toContain("regenerable")
    expect(retired).not.toContain("ANSWER-BODY-SHOULD-BE-GONE")
  })

  it("keeps the message role and id, so the surface shape is unchanged", () => {
    const derived = {
      role: "tool",
      id: "call-7",
      content: [{ type: "text", text: JSON.stringify({ efDerived: {}, answer: "x" }) }],
    } as unknown as Message
    const out = retireDerivedAnswers([derived]).messages[0] as unknown as Record<string, unknown>
    expect(out["role"]).toBe("tool")
    expect(out["id"]).toBe("call-7")
  })

  it("is idempotent, so a second fold does not count the same answer twice", () => {
    const derived = textMessage("tool", JSON.stringify({ efDerived: {}, answer: "x" }))
    const once = retireDerivedAnswers([derived])
    expect(once.retired).toBe(1)
    const twice = retireDerivedAnswers(once.messages)
    expect(twice.retired).toBe(0)
    expect(isRetiredDerived(JSON.stringify(twice.messages[0]!.content))).toBe(true)
  })

  it("distinguishes a LIVE derived answer from a retired one", () => {
    // Conflating them would tell a reader a paraphrase is still available when it is not.
    const live = JSON.stringify({ efDerived: { by: "retrieval-subagent" }, answer: "x" })
    expect(isDerivedAnswer(live)).toBe(true)
    expect(isRetiredDerived(live)).toBe(false)
    const retired = JSON.stringify(retireDerivedAnswers([textMessage("tool", live)]).messages[0]!.content)
    expect(isDerivedAnswer(retired)).toBe(false)
    expect(isRetiredDerived(retired)).toBe(true)
    expect(inventoryOf([textMessage("tool", retired)])[0]).toContain("RETIRED DERIVED ANSWER")
  })

  it("retires nothing when the span holds only raw history", () => {
    const raw = [textMessage("user", "do the thing"), textMessage("tool", "output")]
    const result = retireDerivedAnswers(raw)
    expect(result.retired).toBe(0)
    expect(result.messages).toEqual(raw)
  })
})
