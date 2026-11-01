import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../src/scheduler.mjs'

test('drain is FIFO', async () => {
  const scheduler = createScheduler()
  await scheduler.enqueue({ id: 1 })
  await scheduler.enqueue({ id: 2 })
  assert.deepEqual(await scheduler.drain(), [{ id: 1 }, { id: 2 }])
})
