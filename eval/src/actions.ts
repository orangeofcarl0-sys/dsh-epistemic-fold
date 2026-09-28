/**
 * Action normalization + duplicate-work detection (R0-C1, docs/08 §8-§10).
 * A repeated action counts as duplicate ONLY when its relevant environment
 * version is unchanged — a re-read after the file changed is NOT duplicate.
 *
 * @module eval/actions
 */

import { createHash } from 'node:crypto'
import type { ActionFamily, ActionRecord } from './schema.ts'

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Normalize a search query: lowercase, trim, collapse whitespace. */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/gu, ' ')
}

/** Map a raw tool name to its action family. */
export function actionFamilyOf(toolName: string): ActionFamily {
  const name = toolName.toLowerCase()
  if (name === 'context_recall') return 'recall'
  if (name === 'context_search' || name.includes('search')) return 'search'
  if (name === 'read' || name === 'view' || name === 'cat') return 'read'
  if (name === 'bash' || name === 'test' || name.includes('test')) return 'test'
  if (name === 'edit' || name === 'write' || name === 'str-replace-editor' || name.includes('edit')) return 'edit'
  if (name === 'build' || name === 'compile') return 'build'
  if (name.includes('delegate') || name.includes('subagent')) return 'delegate'
  return 'other'
}

export interface RawActionInput {
  readonly index: number
  readonly toolName: string
  readonly target?: string
  readonly args?: unknown
  readonly beforeEnvironment?: string
  readonly afterEnvironment?: string
}

/** Normalize one raw tool call into an ActionRecord with a stable args hash. */
export function normalizeAction(input: RawActionInput): ActionRecord {
  const normalizedArgs = normalizeArgs(input.toolName, input.target, input.args)
  return {
    index: input.index,
    family: actionFamilyOf(input.toolName),
    toolName: input.toolName,
    ...(input.target === undefined ? {} : { target: input.target }),
    normalizedArgs,
    argsHash: sha256(JSON.stringify(normalizedArgs)),
    ...(input.beforeEnvironment === undefined ? {} : { beforeEnvironment: input.beforeEnvironment }),
    ...(input.afterEnvironment === undefined ? {} : { afterEnvironment: input.afterEnvironment }),
  }
}

function normalizeArgs(toolName: string, target: string | undefined, args: unknown): unknown {
  if (actionFamilyOf(toolName) === 'search' && typeof args === 'object' && args !== null) {
    const record = args as Record<string, unknown>
    if (typeof record.query === 'string') {
      return { ...record, query: normalizeQuery(record.query) }
    }
  }
  return { ...(target === undefined ? {} : { target }), ...(args === undefined ? {} : { args }) }
}

/**
 * Mark duplicates across an ordered action stream: an action is a duplicate
 * when an earlier action has the same family+argsHash AND the relevant
 * environment version did not change between the two occurrences.
 */
export function markDuplicates(actions: readonly ActionRecord[]): ActionRecord[] {
  const lastBySignature = new Map<string, { index: number; environment: string | undefined }>()
  return actions.map(action => {
    const signature = `${action.family}:${action.argsHash}`
    const previous = lastBySignature.get(signature)
    if (previous !== undefined) {
      const environment = action.beforeEnvironment ?? action.afterEnvironment
      const unchanged = previous.environment === undefined
        ? environment === undefined
        : environment === previous.environment
      if (unchanged) {
        lastBySignature.set(signature, { index: action.index, environment: action.afterEnvironment })
        return { ...action, duplicate: true, duplicateOf: previous.index }
      }
    }
    lastBySignature.set(signature, { index: action.index, environment: action.afterEnvironment })
    return action
  })
}
