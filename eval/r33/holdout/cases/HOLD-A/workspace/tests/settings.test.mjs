import test from 'node:test'
import assert from 'node:assert/strict'
import { readSettings } from '../src/settings.mjs'

test('object form returns the new shape', () => {
  const value = readSettings({ name: 'config' })
  assert.equal(value.name, 'config')
  assert.equal(value.retries, 3)
})

test('string form keeps working', () => {
  const value = readSettings('config')
  assert.equal(value.name, 'config')
  assert.equal(value.retries, 3)
})
