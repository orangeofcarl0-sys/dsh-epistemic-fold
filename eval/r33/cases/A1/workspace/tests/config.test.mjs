import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'

test('object form returns the retry policy', () => {
  const config = loadConfig({ path: 'config.json' })
  assert.equal(config.source, 'config.json')
  assert.equal(config.retries, 2)
})
