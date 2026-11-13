import { describe, expect, it } from 'vitest'
import { CANDIDATE, planTaskDelivery } from '../eval/r4/candidate/active-task-delivery.mjs'

const prompt = 'Write result.json with the historical failure count.'

describe('EF-R4 active-task-delivery contract', () => {
  it('does not deliver when the exact source is already visible', () => {
    const plan = planTaskDelivery({
      requests: [{ index: 1, status: 'exact' }, { index: 2, status: 'exact' }],
      prompt,
      sourceSeq: 2,
      sourceDigest: 'digest',
    })
    expect(plan.deliveries).toHaveLength(0)
    expect(plan.rows.every(row => row.deliver === false)).toBe(true)
    expect(plan.candidate).toBe(CANDIDATE)
    expect(plan.mutatesFold).toBe(false)
    expect(plan.pinsSurface).toBe(false)
    expect(plan.authority).toBe('replay-of-original-user-event')
  })

  it('delivers the exact source after the first visible request when it is lost', () => {
    const plan = planTaskDelivery({
      requests: [
        { index: 1, status: 'exact' },
        { index: 2, status: 'absent' },
        { index: 3, status: 'marker-only' },
      ],
      prompt,
      sourceSeq: 2,
      sourceDigest: 'digest',
      maxRedeliveries: 2,
    })
    expect(plan.deliveries).toHaveLength(2)
    expect(plan.deliveries[0]?.request).toBe(2)
    expect(plan.deliveries[0]?.kind).toBe('replay-original-user-event')
    expect(plan.deliveries[0]?.sourceSeq).toBe(2)
    expect(plan.addedChars).toBe(prompt.length * 2)
  })

  it('does not deliver before the task becomes active', () => {
    const plan = planTaskDelivery({
      requests: [{ index: 1, status: 'absent' }, { index: 2, status: 'absent' }],
      prompt,
      sourceSeq: 8,
      sourceDigest: 'digest',
    })
    expect(plan.deliveries).toHaveLength(0)
    expect(plan.rows.every(row => row.reason === 'not-yet-active')).toBe(true)
  })

  it('honours the redelivery bound', () => {
    const plan = planTaskDelivery({
      requests: [
        { index: 1, status: 'exact' },
        { index: 2, status: 'absent' },
        { index: 3, status: 'absent' },
        { index: 4, status: 'absent' },
      ],
      prompt,
      maxRedeliveries: 1,
    })
    expect(plan.deliveries).toHaveLength(1)
    expect(plan.rows.at(-1)?.reason).toBe('redelivery-bound-reached')
  })

  it('does not deliver an empty prompt', () => {
    const plan = planTaskDelivery({
      requests: [{ index: 1, status: 'exact' }, { index: 2, status: 'absent' }],
      prompt: '',
    })
    expect(plan.deliveries).toHaveLength(0)
    expect(plan.rows.at(-1)?.reason).toBe('empty-prompt')
  })
})
