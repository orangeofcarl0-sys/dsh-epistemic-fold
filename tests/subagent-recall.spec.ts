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
  estimateRenderedChars,
  extractJsonObject,
  fallbackPlan,
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
import type { CheckpointBundleV1 } from "../src/types.ts"

function textMessage(role: Message["role"], text: string): Message {
  return { role, content: [{ type: "text", text }] } as Message
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
    expect(estimateRenderedChars({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
    expect(estimateRenderedChars(undefined)).toBe(0)
    // A value that cannot be serialized must not throw inside a tool call.
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    expect(estimateRenderedChars(circular)).toBe(0)
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
      fetch: async request => ({ text: "disk_mb is decimal gb", chars: 22 }),
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