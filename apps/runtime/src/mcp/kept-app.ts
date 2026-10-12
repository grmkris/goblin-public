import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Apps } from '../apps/service.ts'
import { isRecord } from '../runtime/digest.ts'
import { mcpResultDetails } from './extension.ts'
import { toolAppResource } from './remote.ts'
import { Approvals, McpConnections, UrlRequests } from './service.ts'

// The App of a model's call (ADR 0020): kept when the call's result is the App's, however late it comes. A call held
// for the owner's approval, or for a URL request, ends its turn with a placeholder; once the owner has decided and the
// real result is kept, the App is registered and shows that result, not the placeholder.

/**
 * An owner's or model's call to a tool that renders an App keeps that App, so it can be shown in the chat, in its pane
 * and in the sidebar. Keeping it grants nothing: the App's resource and calls need the owner's grants, live.
 */
export const keepModelApp = (
  session: string,
  callId: string,
  input: { readonly connectionId: string; readonly name: string },
) =>
  Effect.gen(function* () {
    const snapshot = Option.getOrUndefined(yield* (yield* McpConnections).snapshot(input.connectionId))
    const tool = snapshot?.tools.find(({ name }) => name === input.name)
    const uri = tool === undefined ? undefined : toolAppResource(tool)
    if (uri === undefined) return
    const origin = { connectionId: input.connectionId, tool: input.name, uri, title: tool?.title ?? input.name }
    yield* (yield* Apps).register(session, callId, origin)
  })

/**
 * The same, for a call whose result arrives after its turn: it must never fail or undo the call that completed, so a
 * failure to keep the App leaves the call as it is (the owner can still open the App from the conversation).
 */
export const keepLateApp = (
  session: string | null,
  callId: string | null,
  input: { readonly connectionId: string; readonly name: string },
) =>
  session === null || callId === null
    ? Effect.void
    : // expected: the call completed; an App that could not be kept can be opened from the conversation again.
      Effect.ignore(keepModelApp(session, callId, input))

/**
 * What an App shows for the result in its call's transcript entry: the real result when that entry is a placeholder
 * for a call the owner approved, or a URL request they finished, and the server has answered it. The placeholder
 * stays for a call that is still waiting, was refused, or has no readable result.
 */
export const settledDetails = (details: unknown) =>
  Effect.gen(function* () {
    if (!isRecord(details) || typeof details['connectionId'] !== 'string') return details
    const connectionId = details['connectionId']
    if (details['kind'] === 'approval-required' && typeof details['approvalId'] === 'string') {
      const result = yield* (yield* Approvals).result(details['approvalId'])
      return Option.match(result, { onNone: () => details, onSome: (value) => mcpResultDetails(connectionId, value) })
    }
    if (details['kind'] === 'url-required' && typeof details['requestId'] === 'string') {
      const result = yield* (yield* UrlRequests).result(details['requestId'])
      return Option.match(result, { onNone: () => details, onSome: (value) => mcpResultDetails(connectionId, value) })
    }
    return details
  }).pipe(
    // expected: a result that cannot be read leaves the placeholder, which is what the transcript says happened.
    Effect.orElseSucceed(() => details),
  )
