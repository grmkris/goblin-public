import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { urlRequestId } from './approvals.ts'
import { named } from './labels.ts'
import { McpServers } from './service.ts'
import { ensureFunded, prepaidJob, unfundedResult } from './top-up.ts'
import { holdUrlRequest } from './url-request.ts'

// A prepaid server's paid job, funded before it goes out (ADR 0049): the model's own call and an approved held call
// both come through here, right before their dispatch.

/** A paid call about to go out: its conversation and call, the server, the tool and the frozen arguments. */
export type PaidCall = {
  readonly session: string
  readonly callId: string
  readonly taskId: string
  readonly connectionId: string
  readonly endpoint: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** Whether the job goes out now, or stops with goblin's result for its turn (and, for an approval, why). */
export type JobFunding =
  | { readonly kind: 'go' }
  | { readonly kind: 'refused'; readonly result: ToolExecutionResult; readonly note: string }
  | { readonly kind: 'asked'; readonly result: ToolExecutionResult }

/**
 * What the job's turn reads when its top-up waits on the wallet's URL request: goblin's own marker for the owner's
 * card, under the job's call (so the card shows where the job does), naming the request; never its link or message.
 */
const askedResult = (call: PaidCall, requestId: string, job: string, wallet: string): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Waiting on the owner: ${job} was short, so goblin started a top-up from ${wallet}, which asks the owner to approve the recipient first. They have a card with the wallet's link. Once they finish or cancel it, the outcome arrives as a new message. The job did not run: stop and wait; do not call it again until then.`,
    },
  ],
  isError: true,
  control: { terminate: true },
  diagnostics: [{ severity: 'info', code: 'url_required', message: 'The owner must approve the top-up first.' }],
  details: { kind: 'url-required', requestId, connectionId: call.connectionId, name: call.name },
})

/**
 * Funds a prepaid server's paid job before it goes out: nothing for any other call. A top-up the wallet asks the owner
 * about is kept as a URL request under the job's call; a job that cannot be funded stops with words for the model.
 */
export const fundJob = (call: PaidCall) =>
  Effect.gen(function* () {
    const micros = prepaidJob(call.endpoint, call.name, call.arguments)
    if (micros === undefined) return { kind: 'go' } satisfies JobFunding
    const funded = yield* ensureFunded(call.connectionId, micros, { session: call.session })
    if (funded.kind === 'ready' || funded.kind === 'moved') return { kind: 'go' } satisfies JobFunding
    if (funded.kind === 'refused')
      return {
        kind: 'refused',
        result: unfundedResult(call.connectionId, call.name, funded.text),
        note: funded.text,
      } satisfies JobFunding
    const { transfer, prompt } = funded
    const input = { connectionId: transfer.wallet, name: transfer.tool, arguments: transfer.arguments }
    yield* holdUrlRequest(call.session, call.callId, call.taskId, input, prompt)
    const labels = yield* (yield* McpServers).labels()
    const requestId = urlRequestId(call.session, call.callId)
    const job = `${named(labels, call.connectionId)} · ${call.name}`
    return {
      kind: 'asked',
      result: askedResult(call, requestId, job, named(labels, transfer.wallet)),
    } satisfies JobFunding
  })
