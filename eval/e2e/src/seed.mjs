/**
 * Build a SEEDED session log.
 *
 * The E2E brief allows a scripted history: replaying a real long task through
 * the model would spend the budget on tokens nobody is measuring. The rule is
 * that the seed must be LABELLED and that the continuation after the fold is
 * real model behaviour. Every report records `seededHistory: true` and the
 * seed digest.
 *
 * The log is a valid, contiguous DSH session:
 *
 *   request/header
 *   turn/start  user/message  step/start  assistant/message  step/end  ...  turn/end
 *
 * A tool entry becomes an assistant message carrying the call plus the paired
 * `tool/call` and `tool/result` events, so the fold sees a legal call/result
 * pair and the tool-pairing guard has something real to check.
 *
 * @module eval/e2e/src/seed
 */

import { randomUUID } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ToolCallId,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'

/**
 * @param entries - `{role:'user'|'assistant'|'tool', text, name?, isError?}`.
 * @param options.provider - the routed provider label.
 * @param options.model - the routed model id.
 * @param options.maxTokens - the per-request output cap recorded in the header.
 * @param options.sessionId - optional stable id.
 */
export function buildSeed(entries, { provider, model, maxTokens, sessionId }) {
  const session = Session.create(SessionId(sessionId ?? `ef-e2e-seed-${randomUUID()}`))

  let turn = 0
  let step = 0
  let open = false
  let headerWritten = false

  const openTurn = () => {
    turn += 1
    session.append('turn/start', { turn })
    open = true
    step = 0
  }
  const openStep = () => {
    step += 1
    session.append('step/start', { turn, step })
    if (!headerWritten) {
      // The first step carries the request header and the system prompt, in
      // the order the loop writes them: step/start, request/header,
      // system/message, then the accepted user batch. A header at seq 0 and a
      // session without a system head both validate in memory and then fail
      // the persisted format on resume ("request/header is outside an open
      // turn", "system/message requires a protected first surface head").
      session.append('request/header', {
        header: { config: { provider, model, maxTokens } },
        reason: 'initial',
      })
      session.append('system/message', {
        turn,
        step,
        message: createSystemMessage('You are a coding assistant. Use the tools to complete the task.'),
      }, { surfaceOp: 'append' })
      headerWritten = true
    }
  }
  const closeTurn = () => {
    if (!open) return
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    open = false
  }

  for (const entry of entries) {
    if (entry.role === 'user') {
      closeTurn()
      openTurn()
      openStep()
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
      continue
    }
    if (!open) openTurn()
    openStep()

    if (entry.role === 'assistant') {
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: entry.text }],
          source: { kind: 'model', provider, model },
        }),
      }, { surfaceOp: 'append' })
    } else if (entry.role === 'tool') {
      const callId = ToolCallId(`call-${turn}-${step}-${randomUUID().slice(0, 8)}`)
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: entry.note ?? `Reading ${entry.name}.` },
            { type: 'tool-call', id: callId, name: entry.name, arguments: entry.arguments ?? '{}' },
          ],
          source: { kind: 'model', provider, model },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: entry.name, arguments: entry.arguments ?? '{}' })
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: entry.text }],
          isError: entry.isError === true,
        }),
      }, { surfaceOp: 'append' })
    } else {
      throw new Error(`seed entry has unknown role: ${String(entry.role)}`)
    }
    session.append('step/end', { turn, step })
  }

  closeTurn()
  return session.snapshotEvents()
}

/**
 * Append one closed turn to a LIVE session (multi-stage cells).
 *
 * This is the stage-B mechanism: the first fold has already happened, the agent
 * is idle, and the next stage's history is appended before the follow-up. The
 * events go through the same `session.append` path as production, so the
 * persistence layer and the projections see them.
 */
export function appendEntriesToSession(session, entries, { provider, model }) {
  let turn = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
  }
  turn += 1
  session.append('turn/start', { turn })
  let step = 0
  for (const entry of entries) {
    step += 1
    session.append('step/start', { turn, step })
    if (entry.role === 'user') {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    } else if (entry.role === 'assistant') {
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: entry.text }],
          source: { kind: 'model', provider, model },
        }),
      }, { surfaceOp: 'append' })
    } else {
      const callId = ToolCallId(`call-${turn}-${step}-${randomUUID().slice(0, 8)}`)
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: entry.note ?? `Reading ${entry.name}.` },
            { type: 'tool-call', id: callId, name: entry.name, arguments: entry.arguments ?? '{}' },
          ],
          source: { kind: 'model', provider, model },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: entry.name, arguments: entry.arguments ?? '{}' })
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: entry.text }],
          isError: entry.isError === true,
        }),
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn, step })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return turn
}

/**
 * Append one more closed turn to an existing persisted session log.
 *
 * Multi-stage cells (T5) use this to grow the history between folds without
 * inventing a second mechanism.
 */
export function appendTurn(events, entries, { provider, model, maxTokens }) {
  const session = Session.create(SessionId(`ef-e2e-append-${randomUUID()}`), events)
  let turn = 0
  for (const event of events) if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
  turn += 1
  session.append('turn/start', { turn })
  let step = 0
  for (const entry of entries) {
    step += 1
    session.append('step/start', { turn, step })
    if (entry.role === 'user') {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    } else if (entry.role === 'assistant') {
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: entry.text }],
          source: { kind: 'model', provider, model },
        }),
      }, { surfaceOp: 'append' })
    } else {
      const callId = ToolCallId(`call-${turn}-${step}-${randomUUID().slice(0, 8)}`)
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: entry.note ?? `Reading ${entry.name}.` },
            { type: 'tool-call', id: callId, name: entry.name, arguments: entry.arguments ?? '{}' },
          ],
          source: { kind: 'model', provider, model },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: entry.name, arguments: entry.arguments ?? '{}' })
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: entry.text }],
          isError: entry.isError === true,
        }),
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn, step })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}
