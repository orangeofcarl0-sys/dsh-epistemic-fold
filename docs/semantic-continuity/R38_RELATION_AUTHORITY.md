# R38-M0 — Relation Authorization

## 1. The question

R37-D's N5 showed that a legal revision which supersedes one coordinate can
leave a stale anchor active at another. That was treated as an incompleteness
bug. R38-M0 asks the prior question:

> If a claim is accepted, is its **retirement operation** also authorized?

The pre-R38 answer was no. `validateDeltas` checked the claim's evidence,
authority domain and status. `planCommit` then resolved every `supersedes`
target and emitted a retire op for it. The target's authority was never
consulted. The reducer retired whatever it was told to retire.

## 2. Reproduction before the fix

The following ran on the R37-D tree (`7a2c974`) through the real
`validateDeltas → planCommit → applyOps` path, with a user constraint declared
first and a tool-grounded finding second:

```text
first refused []
state constraints [ 'semantic-1ff14e54d7e39d0fcff6593e70dde187' ]
second refused []
plan2 ops [
  { op: 'declare', anchor: …finding… },
  { op: 'retire', anchorId: 'semantic-1ff14e54d7e39d0fcff6593e70dde187' }
]
after constraints [] retired 1
```

The same result followed an assistant decision naming the constraint anchor.
The claim was valid in both cases; the **operation** was not authorized, and
nothing checked.

## 3. The invariant

```text
Claim Authority ≠ Retirement Authority
```

A claim may be accepted without being authorized to retire a target. The
validator answers "may this claim be recorded?". The planner answers "may this
claim take that anchor out of hot state?".

## 4. The rule

`src/semantic/retirement.ts` ranks authority domains ordinally:

```text
normative  5   user or system requirement
decision   4   a decision was taken (user or assistant)
procedural 3   a tool documented a procedure
empirical  3   a tool observed a fact
hypothesis 1   an assistant speculated
narrative  0   derived summary text; never an authority root
```

A retirement is authorized only when:

1. the declaring domain is not `narrative`;
2. the target domain is not `narrative`;
3. the two anchors are in the **same task scope**;
4. `power(declaring) >= power(target)`.

`procedural` and `empirical` share a rank because both are tool-produced.
`decision` outranks them because a decision may legitimately set aside an
observation. `normative` outranks `decision` because only a normative source may
revoke a requirement.

`EpistemicStatus` is deliberately **not** used: `verified` measures evidence,
not standing. A verified tool observation still cannot revoke a user constraint.

Scope is a second, independent gate. Even a normative claim may not reach
across task scopes by naming another scope's anchor id.

## 5. What happens to a refused retirement

The claim is still declared; only the operation is dropped. The packet records:

```ts
retirement: {
  refused: [{ deltaId, target, anchorId, reason }]
}
```

This is the distinction the brief requires: the fact is not lost, and the
system does not pretend the target was retired.

## 6. Scenario results

`eval/r38/out/relation-security-audit.json` — 8/8 scenarios passed.

| Scenario | Expected | Blocked at |
|---|---|---|
| Tool finding vs user constraint | constraint stays active | planner `insufficient-authority` |
| Assistant decision vs user constraint | constraint stays active | planner `insufficient-authority` |
| User revision | new value active, old superseded | — (applies) |
| Same-scope decision revision | queue retired, outbox active | — (applies) |
| Cross-scope explicit anchor id | refused, constraint active | planner `cross-scope` |
| Nonexistent target | delta withheld | planner `unresolved-target` |
| Forged tool instruction | proposal refused | validator `authority-ungrounded` |
| Ambiguous bare subject | delta withheld | planner `ambiguous-target` |

The matrix is also asserted directly:

```text
normative -> decision      allowed
decision  -> empirical     allowed
empirical -> normative     refused (insufficient-authority)
hypothesis-> normative     refused (insufficient-authority)
normative -> decision      refused (cross-scope)
```

## 7. Limitations

- `decision` does not distinguish a user-taken decision from an
  assistant-taken one. The domain is granted by the kind, and both producers
  ground it. A user decision can therefore be retired by an assistant decision
  at the same rank. This is narrower than the tool-vs-user hole and is recorded
  here rather than silently fixed by changing the domain model.
- A same-coordinate replacement is not authority-checked. The coordinate
  includes the semantic kind, and the kind fixes the authority domain, so a
  same-coordinate replacement is always same-domain. The remaining gap is the
  user/assistant `decision` distinction above.
- Cross-scope retirement is refused even for a normative claim. A user who
  really wants to revoke another scope's constraint must restate the claim in
  that scope. This is conservative by design.

## 8. Compatibility

- `deltaIdentity` is unchanged. Historical anchor ids are byte-identical.
- Replay reads recorded `ops`; it never re-runs `planCommit`. Old packets
  replay exactly as before.
- New packets may carry fewer retire ops than they would have before. That is
  the intended change; `opsDigest` is computed from the actual ops.
- The packet gains an optional `retirement` audit field. `isSemanticPacket`
  ignores unknown fields; the field is not part of the packet identity.

## 9. Evidence

```text
src/semantic/retirement.ts
src/semantic/plan.ts
src/semantic/validate.ts
src/semantic/types.ts
src/fold/engine.ts
tests/r38-relation-authority.spec.ts                 19/19
eval/r38/relation-security.mjs
eval/r38/out/relation-security-audit.json            8/8
```
