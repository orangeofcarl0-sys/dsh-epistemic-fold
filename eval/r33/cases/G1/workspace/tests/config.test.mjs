import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'

test('timeoutMs defaults to 500', () => {
  assert.equal(loadConfig({ path: 'config.json' }).timeoutMs, 500)
})
