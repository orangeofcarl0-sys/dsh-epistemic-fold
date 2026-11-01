import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
const root = process.env.R33_WORKSPACE
const checks = []
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }) }
  catch (error) { checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }) }
}

let importer
try { importer = await import(pathToFileURL(join(root, "src/importer.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/importer.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('functionality.rows-preserved', () => assert.equal(importer.importRows([{ id: 1 }]).rows.length, 1))
await check('dependency.artifact-version', () => assert.equal(importer.importRows([{ id: 1 }]).schemaVersion, 'schema-v2'))
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
