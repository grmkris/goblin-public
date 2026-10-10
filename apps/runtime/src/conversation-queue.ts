import { InboxDoc, type Harness } from '@earendil-works/pi-durable'
import { ConversationQueue, type QueueRemoval, type QueueRemovalResult } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { attempt } from './http/errors.ts'
import { Conversations } from './chats/service.ts'
import { RoutineRuns } from './routines/service.ts'
import { BACKGROUND, conversationId, submissionId } from './pi/context.ts'
import { PiSessions, fromPi } from './pi/sessions.ts'

/** Read Pi's supported inbox document; neither the transcript nor application storage owns these inputs. */
export async function queuedInputs(pi: Harness, session: string): Promise<ConversationQueue> {
  const inbox = await pi.snapshot(InboxDoc, conversationId(session), BACKGROUND)
  return Schema.decodeSync(ConversationQueue)({
    inputs: inbox?.items.filter((item) => item.mode !== 'write') ?? [],
  })
}

/** Helpers and routine conversations use separate delivery flows, outside this owner queue. */
const ownerQueueSession = (thread: string) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const session = yield* conversations.require(thread)
    const kind = yield* conversations.kindOf(thread)
    if (kind === 'subagent' || (yield* (yield* RoutineRuns).session(session)) !== undefined) return undefined
    return session
  })

/** Pi's opened harness, its failure as an `AppError`. */
const harness = PiSessions.use((pi) => fromPi(pi.pi))

/** A shared browser stream may follow helpers and routines too; their queues are deliberately absent here. */
export const ownerQueue = (thread: string) =>
  Effect.gen(function* () {
    const session = yield* ownerQueueSession(thread)
    if (session === undefined) return { inputs: [] }
    const pi = yield* harness
    return yield* attempt(() => queuedInputs(pi, session))
  })

const outcomes = {
  aborted: 'removed',
  already_placed: 'already_started',
  settled: 'already_settled',
  not_found: 'not_found',
} as const

/** The queued-only native operation checks placement atomically; it never aborts an active run. */
export async function withdrawQueuedInput(pi: Harness, session: string, id: number): Promise<QueueRemovalResult> {
  const conversation = conversationId(session)
  const submission = submissionId(id)
  const record = await (await pi.submission(submission, BACKGROUND))?.status(BACKGROUND)
  if (record?.conversationId !== conversation || record.type !== 'input') return { status: 'not_found' }
  return { status: outcomes[await pi.abortSubmission(submission, BACKGROUND, conversation)] }
}

export const removeOwnerQueuedInput = (thread: string, input: QueueRemoval) =>
  Effect.gen(function* () {
    const session = yield* ownerQueueSession(thread)
    if (session === undefined) return { status: 'not_found' as const }
    const pi = yield* harness
    return yield* attempt(() => withdrawQueuedInput(pi, session, input.submissionId))
  })
