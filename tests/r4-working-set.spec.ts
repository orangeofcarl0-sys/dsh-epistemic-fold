import { describe, expect, it } from 'vitest'
import { errorClassOf, failureRows, pathOf, sectionOf } from '../eval/r4/working-set.mjs'

const checkpoint = `[EF1 L cp:11111111-1111-4111-8111-111111111111]

Open
- [failure] failure:call_a (open): {"callId":"call_a"}
- [failure] failure:call_b (open): {"callId":"call_b"}
- [failure] failure:call_a2 (open): {"callId":"call_a2"}

Rationale
- The task asked for release.json.`

describe('EF-R4 working-set instrumentation', () => {
  it('extracts only the Open section', () => {
    const open = sectionOf(checkpoint, 'Open')
    expect(open).toContain('failure:call_a')
    expect(open).not.toContain('Rationale')
  })

  it('parses failure anchors and their call ids', () => {
    const rows = failureRows(checkpoint)
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows[0]?.callId).toBe('call_a')
    expect(rows.rows[2]?.state).toBe('open')
  })

  it('extracts a path or query from tool arguments', () => {
    expect(pathOf('{"path":"logs/deploy-1.log"}')).toBe('logs/deploy-1.log')
    expect(pathOf('{"query":"failed=3"}')).toBe('failed=3')
    expect(pathOf('not json')).toBeNull()
  })

  it('classifies a repeated missing path as ENOENT', () => {
    expect(errorClassOf("Error: ENOENT: no such file or directory, open 'logs/deploy-1.log'")).toBe('ENOENT')
    expect(errorClassOf('permission denied')).toBe('tool-error')
    expect(errorClassOf('')).toBe('unknown')
  })
})
