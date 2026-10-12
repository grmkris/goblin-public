import { isString, record } from './values.ts'

// An App kept for a call shows that call's result. A call that never completed (held, refused, not allowed, not signed
// in) has a marker in the transcript instead, and its App is told the call was cancelled (`ui/notifications/tool-cancelled`)
// rather than being left to wait for a result that will not come.

/** Why a call's marker means it did not complete, in words an App may show. */
const REASONS: Readonly<Record<string, string>> = {
  'approval-required': 'The call is waiting for the owner, or the owner refused it.',
  'url-required': 'The call is waiting for a step the owner has not finished, or the owner cancelled it.',
  'grant-required': 'The owner has not allowed this tool.',
  'connect-required': 'The connection is not signed in.',
  'scope-required': 'The connection needs more access for this tool.',
}

/** The reason the call behind `details` was cancelled, or undefined when `details` is a result. */
export function cancelledReason(details: unknown): string | undefined {
  const kind = record(details)?.kind
  return isString(kind) && Object.hasOwn(REASONS, kind) ? REASONS[kind] : undefined
}
