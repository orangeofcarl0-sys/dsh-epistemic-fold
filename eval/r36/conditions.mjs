#!/usr/bin/env node
/**
 * R36-F1: freeze the conditions a later live run would use.
 *
 * This script reads and hashes the actual artifacts; it does not call a model
 * and does not read a credential. The output is the identity a report can cite
 * so a result cannot silently move under a changed prompt, parser, validator,
 * harness, scorer, or dataset.
 *
 * @module eval/r36/conditions
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDataset } from '../r33/src/dataset.mjs'
import { SCORER_VERSION } from '../r33/src/grade.mjs'
import {
  SEMANTIC_WRITER_INSTRUCTION_W0,
  SEMANTIC_WRITER_INSTRUCTION_W1,
  SEMANTIC_WRITER_PROMPT_VERSION,
} from '../../src/semantic/writer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'out', 'conditions.json')

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function fileDigest(relative) {
  return digest(await readFile(join(ROOT, relative), 'utf8'))
}

const { datasetDigest } = await loadDataset()
let liveEvidence = null
try {
  liveEvidence = JSON.parse(await readFile(join(HERE, 'out', 'live-results.json'), 'utf8'))
} catch {
  // No live run yet: conditions still freeze the planned inputs.
}
const conditions = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dataset: {
    id: 'r33-semantic-continuity-v2',
    digest: datasetDigest,
  },
  scorer: {
    version: SCORER_VERSION,
    sourceDigest: await fileDigest('eval/r33/src/grade.mjs'),
    note: 'v3 derives the final verification state from trusted tool runs; expectedClaim is historical t0 only.',
  },
  writer: {
    productionVersion: SEMANTIC_WRITER_PROMPT_VERSION,
    prompts: {
      W0: { chars: SEMANTIC_WRITER_INSTRUCTION_W0.length, digest: digest(SEMANTIC_WRITER_INSTRUCTION_W0) },
      W1: { chars: SEMANTIC_WRITER_INSTRUCTION_W1.length, digest: digest(SEMANTIC_WRITER_INSTRUCTION_W1) },
    },
    sourceDigest: await fileDigest('src/semantic/writer.ts'),
    parser: {
      P0: { sourceDigest: await fileDigest('eval/r36/writer-protocol.mjs'), policy: 'strict production parseWriterOutput' },
      P1: {
        sourceDigest: await fileDigest('eval/r36/writer-protocol.mjs'),
        policy: 'bounded envelope recovery; eval ablation only; no fact/kind/status/evidence rewriting',
      },
    },
  },
  validator: {
    sourceDigest: await fileDigest('src/semantic/validate.ts'),
    authoritySourceDigest: await fileDigest('src/state/authority.ts'),
    note: 'W1-P0 uses this validator unchanged; P1 proposals are revalidated by it.',
  },
  harness: {
    H0: {
      version: 'H0-custom-json-loop',
      steps: 8,
      maxTokensPerTurn: 1024,
      tools: ['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish'],
      finishGuard: false,
      sourceDigest: await fileDigest('eval/r33/live.mjs'),
    },
    variants: {
      'H-step': { steps: 16, maxTokensPerTurn: 1024, finishGuard: false },
      'H-output': { steps: 8, maxTokensPerTurn: 4096, finishGuard: false },
      'H-finish': { steps: 8, maxTokensPerTurn: 1024, finishGuard: true },
      'H-native': { runtime: 'dsh-agent', status: 'not-implemented' },
    },
  },
  model: {
    id: 'deepseek-v4.1-flash',
    provider: liveEvidence === null
      ? 'opencode'
      : 'zcode local proxy (provider c15ab109-97b8-4de1-a647-9857a635be38)',
    route: liveEvidence === null
      ? 'https://opencode.ai/zen/go/v1'
      : 'http://127.0.0.1:7866/v1',
    note: liveEvidence === null
      ? 'The model and route are frozen for the planned experiment; no R36 request was made.'
      : 'The three direct /zen/go/v1 keys answered HTTP 401 api_key_expired. The authorized runs used the local ZCode proxy at the production 16,384-token bound.',
  },
  live: {
    authorization: liveEvidence?.authorization?.status === 'granted'
      ? 'granted-in-this-session'
      : (process.env.R36_LIVE_AUTHORIZED === '1' ? 'granted-by-environment' : 'not-granted-in-this-session'),
    gate: 'R33_LIVE=1, resolved route, positive limits, and an explicit manifest are still required.',
    evidence: liveEvidence === null
      ? null
      : {
        writerRuns: liveEvidence.writer?.runs?.map(run => run.runId) ?? [],
        harnessConditions: liveEvidence.harness?.conditions?.map(condition => ({
          condition: condition.condition,
          runIds: condition.runIds,
        })) ?? [],
        causal: liveEvidence.causal ?? null,
        httpAttempts: liveEvidence.cost?.total?.attempts ?? null,
      },
  },
}
await writeFile(OUT, `${JSON.stringify(conditions, null, 2)}\n`, 'utf8')
process.stdout.write(`conditions: ${OUT}\n`)
process.stdout.write(`W0 ${conditions.writer.prompts.W0.digest.slice(0, 16)}  W1 ${conditions.writer.prompts.W1.digest.slice(0, 16)}\n`)
process.stdout.write(`dataset ${datasetDigest.slice(0, 16)}  scorer v${SCORER_VERSION}\n`)
process.stdout.write(`live: ${conditions.live.authorization}\n`)
