/**
 * The custom loop's multi-action contract.
 *
 * A model turn may contain several actions. The loop executes every non-finish
 * action in the order the model emitted it, then evaluates a single finish
 * request. `finish` is a control action, not an ordered tool call: if the model
 * writes `finish` before `write_file`, the write still executes first.
 *
 * This helper makes that contract explicit and testable. It does not reorder
 * the non-finish actions.
 *
 * @module eval/r33/src/action-order
 */

/**
 * Split a parsed turn into non-finish actions and the first finish request.
 *
 * @param {readonly object[]} actions
 * @returns {{nonFinish: object[], finish: object|null, finishPosition: number}}
 */
export function splitFinishActions(actions) {
  const nonFinish = []
  let finish = null
  let finishPosition = -1
  for (const [index, action] of actions.entries()) {
    if (action?.tool === 'finish') {
      if (finish === null) {
        finish = action
        finishPosition = index
      }
      continue
    }
    nonFinish.push(action)
  }
  return { nonFinish, finish, finishPosition }
}
