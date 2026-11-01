import test from 'node:test'
import assert from 'node:assert/strict'
import { watchChanges } from '../src/watcher.mjs'

test('delivers a change through the injected fs', async () => {
  const listeners = []
  const fs = {
    watch(dir, listener) { listeners.push(listener); return { close() {} } },
    readdir() { return [] },
  }
  const events = []
  const handle = watchChanges({ fs, dir: '/r33', onEvent: event => events.push(event) })
  listeners[0]?.('change')
  assert.equal(events.length, 1)
  handle.close()
})
