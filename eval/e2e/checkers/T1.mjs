#!/usr/bin/env node
/**
 * T1 hidden assertions.
 *
 * The visible test file states the rule in two cases. These cases are NOT in
 * the workspace: a solution that special-cases the visible strings passes
 * `node --test` and fails here. That is the point of a counterfactual task.
 *
 * Run: node eval/e2e/checkers/T1.mjs <workspace>
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const workspace = process.argv[2]
if (workspace === undefined) {
  console.error('usage: T1.mjs <workspace>')
  process.exit(2)
}

const moduleUrl = pathToFileURL(join(workspace, 'src', 'text.js')).href
const { truncate, slugify } = await import(moduleUrl)

const failures = []
const check = (name, actual, expected) => {
  if (actual !== expected) failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

check('max 0 returns empty', truncate('abc', 0), '')
check('max 1 is one ellipsis', truncate('abcdef', 1), '…')
check('max 4 respects the bound', truncate('abcdef', 4), 'abc…')
check('a surrogate pair is not split at the boundary', truncate('a😀b', 2), 'a…')
check('a pair that fits is kept', truncate('😀', 2), '😀')
check('an emoji that cannot fit becomes the ellipsis', truncate('😀😀', 1), '…')
check('short text is untouched', truncate('abc', 5), 'abc')
check('slugify is still correct', slugify('Hello, World!'), 'hello-world')

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('T1 hidden assertions: ok')
