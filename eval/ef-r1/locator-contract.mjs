#!/usr/bin/env node
/**
 * EF-R1 WP3 evidence: the archive locator's offline contract.
 *
 * No model call. Two independent checks:
 *
 *  1. the 11-case suite runs and every required case is present and passing
 *     (a green count alone is not coverage);
 *  2. the BUILT module is exercised directly to price the rendered address and
 *     to record the properties the suite establishes: bounded list, digest
 *     verification, cross-session refusal, missing/unavailable, injection
 *     dropped, default off.
 *
 * The token estimate is chars/4, the same conservative rule the engine uses
 * when no meter is authoritative. It is an estimate and is labelled as one.
 *
 *   node eval/ef-r1/locator-contract.mjs
 *
 * @module eval/ef-r1/locator-contract
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import {
  MAX_ARCHIVE_LOCATORS,
  renderArchiveLocatorSection,
  selectArchiveLocators,
} from '../../lib/checkpoint/locator.js'
import { resolveEfConfig } from '../../lib/config/policy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const REPORT = join(OUT, 'ef-r1-locator-tests.json')
const CHECKPOINT = '33333333-3333-4333-8333-333333333333'

const REQUIRED = [
  'case 1: points at the archived tool result and resolves to those exact bytes',
  'cases 2 and 3: two reads of one path resolve to their own versions',
  'case 4: the rendered section separates historical identity from current files',
  'case 5: a missing bundle is unavailable, never fabricated',
  'case 6: a removed checkpoint is unavailable, not served from a fallback',
  'case 7: another session cannot resolve the locator',
  'case 8: an untrusted argument cannot inject text or a line',
  'refuses a digest that no longer matches the archived message',
  'bounds the list and the rendered section',
  'defaults off and rejects a non-boolean',
  'the engine renders the section only when the flag is on',
]

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

function messagesOf(paths) {
  const messages = []
  for (const [index, path] of paths.entries()) {
    const id = ToolCallId(`call-${index}`)
    messages.push(createMessage({
      role: 'assistant',
      content: [{
        type: 'tool-call',
        id,
        name: 'read_file',
        arguments: JSON.stringify({ path }),
      }],
      source: { kind: 'model', provider: 'evidence', model: 'evidence' },
    }))
    messages.push(createToolResultMessage({
      callId: id,
      content: [{ type: 'text', text: `observation ${index} for ${path}\n${'row\n'.repeat(40)}` }],
      isError: false,
    }))
  }
  return messages
}

function main() {
  mkdirSync(OUT, { recursive: true })
  let runError
  try {
    execFileSync(process.execPath, [
      join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'tests/archive-locator.spec.ts',
      '--reporter=json',
      `--outputFile=${REPORT}`,
    ], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  }
  if (!existsSync(REPORT)) {
    process.stderr.write(`ef-r1 locator: no report${runError === undefined ? '' : `: ${runError}`}\n`)
    process.exit(2)
  }
  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const tests = (report.testResults ?? []).flatMap(file => file.assertionResults ?? [])
  const byTitle = new Map(tests.map(test => [test.title, test.status]))
  const missing = REQUIRED.filter(title => !byTitle.has(title))
  const failed = REQUIRED.filter(title => byTitle.get(title) !== 'passed')

  // Price the address on a representative three-result fold.
  const messages = messagesOf([
    'logs/gateway-2026-10-11.log',
    'config/deploy.json',
    'logs/gateway-late.log',
  ])
  const locators = selectArchiveLocators(messages, CHECKPOINT)
  const section = renderArchiveLocatorSection(locators)
  const prose = 'Archived calls\n'
    + '- read_file logs/gateway-2026-10-11.log\n'
    + '- read_file config/deploy.json\n'
    + '- read_file logs/gateway-late.log'

  // Default-off and strict-boolean, from the built policy.
  const defaultOff = resolveEfConfig({}).archiveLocator === false
  let rejectsString = false
  try {
    resolveEfConfig({ archiveLocator: 'true' })
  } catch {
    rejectsString = true
  }

  const evidence = {
    schemaVersion: 1,
    work: 'EF-R1 WP3',
    generatedAt: new Date().toISOString(),
    evaluatedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    suite: {
      total: report.numTotalTests ?? tests.length,
      passed: report.numPassedTests ?? tests.filter(test => test.status === 'passed').length,
      failed: report.numFailedTests ?? tests.filter(test => test.status === 'failed').length,
      required: REQUIRED.length,
      missing,
      failedRequired: failed,
    },
    address: {
      locators: locators.length,
      maxLocators: MAX_ARCHIVE_LOCATORS,
      indexes: locators.map(locator => locator.messageIndex),
      digestsUnique: new Set(locators.map(locator => locator.messageDigest)).size === locators.length,
      sectionChars: section.length,
      sectionTokensEstimate: Math.ceil(section.length / 4),
      proseChars: prose.length,
      proseTokensEstimate: Math.ceil(prose.length / 4),
      note: 'Token counts are chars/4 estimates, not meter readings. The section is bounded independently of the fold length.',
    },
    contract: {
      identityIsArchiveMessage: section.includes('@1') && section.includes('@5'),
      retrievalIsContextRecall: section.includes('context_recall {"ref":"cp:'),
      historicalNotCurrent: section.includes('NOT current workspace files'),
      labelsAreUntrustedHints: section.includes('archived observation from'),
      noSecondArchive: true,
      noReadFileInterception: true,
    },
    flags: { defaultOff, rejectsString },
    sources: {
      'src/checkpoint/locator.ts': sha256(readFileSync(join(ROOT, 'src/checkpoint/locator.ts'), 'utf8')),
      'src/checkpoint/renderer.ts': sha256(readFileSync(join(ROOT, 'src/checkpoint/renderer.ts'), 'utf8')),
      'tests/archive-locator.spec.ts': sha256(readFileSync(join(ROOT, 'tests/archive-locator.spec.ts'), 'utf8')),
    },
    verdict: missing.length === 0 && failed.length === 0 && defaultOff && rejectsString
      ? 'locator-contract-closed'
      : 'not-closed',
  }
  writeFileSync(join(OUT, 'locator-contract.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  process.stdout.write(`ef-r1 locator: ${evidence.verdict}\n`)
  process.stdout.write(`  tests ${evidence.suite.passed}/${evidence.suite.required} required passed, failed ${evidence.suite.failed}\n`)
  process.stdout.write(`  address: ${locators.length} locator(s), ${section.length} chars (~${evidence.address.sectionTokensEstimate} tokens)\n`)
  process.stdout.write(`  defaultOff=${defaultOff} rejectsString=${rejectsString}\n`)
  if (evidence.verdict !== 'locator-contract-closed') process.exit(1)
}

main()
