import { Conflict } from '@goblin/contracts/api'
import { messageOf } from '../../lib/query/app-error.ts'
import { withRef } from '../../lib/refusal.ts'

/** Why an Undo was refused, in words: something changed the target since, or it was already undone. */
export function undoRefusal(failure: unknown): string {
  if (failure instanceof Conflict && failure.reason === 'touched')
    return withRef('Changed since, so it cannot be undone.', failure)
  if (failure instanceof Conflict && failure.reason === 'undone') return withRef('Already undone.', failure)
  return messageOf(failure, 'undo it')
}
