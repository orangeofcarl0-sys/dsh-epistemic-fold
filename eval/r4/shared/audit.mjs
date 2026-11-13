/**
 * EF-R4 shared readers.
 *
 * These helpers read only immutable R3 artifacts. They never write into a run
 * directory and never call a provider. The same functions are used by the
 * evidence graph, the task-continuity audit and the working-set analysis, so a
 * sequence or digest means the same thing in every R4 artifact.
 *
 * @module eval/r4/lib/audit
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest('hex')

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Load a campaign without touching the network. The task file is resolved from
 * the manifest entry, not guessed from the id.
 */
export function loadCampaign({ campaign, root = ROOT }) {
  const manifestPath = join(root, 'eval', 'e2e', 'out', `manifest-${campaign}.json`)
  const resultsPath = join(root, 'eval', 'e2e', 'out', `results-${campaign}.json`)
  for (const path of [manifestPath, resultsPath]) {
    if (!existsSync(path)) throw new Error(`missing campaign artifact: ${path}`)
  }
  const manifest = readJson(manifestPath)
  const results = readJson(resultsPath)
  const tasks = new Map((manifest.tasks ?? []).map(entry => [entry.id, entry]))
  return { root, manifest, results, tasks, manifestPath, resultsPath }
}

/** Read one executed cell's report, raw messages, witness and task. */
export function loadCell({ root = ROOT, row, tasks }) {
  const taskId = row.cell?.task ?? row.cellId?.split('-').slice(0, 2).join('-')
  const taskEntry = tasks.get(taskId)
  const task = taskEntry !== undefined && existsSync(join(root, taskEntry.file))
    ? readJson(join(root, taskEntry.file))
    : null
  const reportPath = row.reportPath === undefined || row.reportPath === null
    ? null
    : resolve(root, row.reportPath)
  const report = reportPath !== null && existsSync(reportPath) ? readJson(reportPath) : null
  const cellRoot = reportPath === null ? null : dirname(reportPath)
  const messagesPath = cellRoot === null ? null : join(cellRoot, 'raw', 'messages.json')
  const witnessPath = cellRoot === null ? null : join(cellRoot, 'raw', 'witness.json')
  return {
    cellId: row.cellId ?? null,
    taskId,
    arm: row.cell?.arm ?? null,
    replicate: row.cell?.replicate ?? null,
    report,
    reportPath,
    task,
    messages: messagesPath !== null && existsSync(messagesPath) ? readJson(messagesPath) : null,
    rawWitness: witnessPath !== null && existsSync(witnessPath) ? readJson(witnessPath) : null,
  }
}

/**
 * The live portion starts at the first user message carrying the task prompt.
 * Seeded history precedes it and is still part of the surface; this boundary
 * only separates the pre-task fold from the folds caused by the live turn.
 */
export function liveStartOf(trajectory, task) {
  const prompt = task?.task ?? ''
  const exact = trajectory.findIndex(event => event.type === 'user'
    && typeof event.text === 'string'
    && (event.text === prompt || event.text.startsWith(prompt.slice(0, 40))))
  if (exact !== -1) return exact
  const firstCompaction = trajectory.findIndex(event => event.type === 'compaction/start')
  if (firstCompaction !== -1) {
    for (let index = firstCompaction; index >= 0; index -= 1) {
      if (trajectory[index].type === 'user') return index
    }
  }
  return 0
}

export function liveStartSeqOf(trajectory, task) {
  const index = liveStartOf(trajectory, task)
  return trajectory[index]?.seq ?? 0
}

/**
 * Pair tool calls with their results. The harness runs one tool at a time, so
 * the next result belongs to the pending call. The result carries the callId;
 * the call itself carries the name and the (possibly truncated) arguments.
 */
export function pairToolCalls(trajectory) {
  const pairs = []
  let pending = null
  for (const event of trajectory) {
    if (event.type === 'tool/call') {
      pending = {
        callSeq: event.seq,
        name: event.name ?? 'unknown',
        argsText: event.args?.text ?? '',
        argsTruncated: event.args?.truncated === true,
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    if (pending === null) continue
    pairs.push({
      ...pending,
      resultSeq: event.seq,
      callId: typeof event.callId === 'string' && event.callId.length > 0 ? event.callId : null,
      isError: event.isError === true,
      resultPreview: event.text ?? '',
      resultTruncated: event.truncated === true,
    })
    pending = null
  }
  return pairs
}

/** Per primary request: full text, text digests and tool messages by callId. */
export function buildRequestIndex(messages) {
  const requests = []
  const requestByToolCallId = new Map()
  for (const entry of messages ?? []) {
    const toolCallIds = new Set()
    const toolCallIdText = new Map()
    const textDigests = new Set()
    const texts = []
    const userTexts = []
    for (const message of entry.messages ?? []) {
      const text = textOfContent(message.content)
      if (text.length > 0) {
        textDigests.add(sha256(text))
        texts.push(text)
        if (message.role === 'user') userTexts.push(text)
      }
      if (message.role === 'tool' && typeof message.toolCallId === 'string') {
        toolCallIds.add(message.toolCallId)
        toolCallIdText.set(message.toolCallId, text)
        if (!requestByToolCallId.has(message.toolCallId)) requestByToolCallId.set(message.toolCallId, entry.index)
      }
    }
    requests.push({
      index: entry.index,
      at: entry.at ?? null,
      messages: entry.messages ?? [],
      toolCallIds,
      toolCallIdText,
      textDigests,
      text: texts.join('\n'),
      userText: userTexts.join('\n'),
    })
  }
  return { requests, requestByToolCallId }
}

/** Paths declared by the task checks. These are the delivery contract. */
export function requiredArtifactsOf(task) {
  const paths = new Set()
  for (const check of task?.checks ?? []) {
    if (typeof check.path === 'string' && check.path.length > 0) paths.add(check.path)
  }
  return [...paths].sort()
}

/** Assistant tool-call blocks carry the full name and arguments. */
export function toolCallNameIndex(messages) {
  const names = new Map()
  for (const entry of messages ?? []) {
    for (const message of entry.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block?.type !== 'tool-call') continue
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          names.set(block.id, block.name)
        }
      }
    }
  }
  return names
}

/** Full call metadata, keyed by the tool-call id. First occurrence wins. */
export function toolCallInfoIndex(messages) {
  const info = new Map()
  for (const entry of messages ?? []) {
    for (const message of entry.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block?.type !== 'tool-call') continue
        if (typeof block.id !== 'string' || info.has(block.id)) continue
        info.set(block.id, {
          name: typeof block.name === 'string' ? block.name : 'unknown',
          argsText: typeof block.arguments === 'string' ? block.arguments : '',
        })
      }
    }
  }
  return info
}

/** Full tool result text, keyed by tool-call id. */
export function toolMessageTextIndex(messages) {
  const text = new Map()
  for (const entry of messages ?? []) {
    for (const message of entry.messages ?? []) {
      if (message.role !== 'tool' || typeof message.toolCallId !== 'string') continue
      if (!text.has(message.toolCallId)) text.set(message.toolCallId, textOfContent(message.content))
    }
  }
  return text
}

/** The first primary request that carries a result for a named tool. */
export function firstRequestWithTool(messages, names) {
  const wanted = new Set(names)
  const callNames = toolCallNameIndex(messages)
  for (const entry of messages ?? []) {
    for (const message of entry.messages ?? []) {
      if (message.role !== 'tool' || typeof message.toolCallId !== 'string') continue
      const name = callNames.get(message.toolCallId)
      if (name !== undefined && wanted.has(name)) return entry.index
    }
  }
  return null
}

/** A checkpoint message is a user message carrying the EF marker. */
export function isCheckpointText(text) {
  return typeof text === 'string' && /^\[EF1\s+\w+\s+cp:[0-9a-f-]+\]/iu.test(text)
}

export function checkpointTextOf(request, checkpointSha256) {
  if (request === null || request === undefined || typeof checkpointSha256 !== 'string') return null
  for (const message of request.messages ?? []) {
    const text = textOfContent(message.content)
    if (text.length > 0 && sha256(text) === checkpointSha256) return text
  }
  return null
}
