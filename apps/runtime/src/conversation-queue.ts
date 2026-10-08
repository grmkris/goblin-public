import { InboxDoc, type Harness } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { ConversationQueue } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Conversations, RoutineRuns, attempt, attemptSync } from './services.ts'
import { BACKGROUND, conversationId } from './pi/context.ts'

/** Read Pi's supported inbox document; neither the transcript nor application storage owns these inputs. */
export async function queuedInputs(pi: Harness, session: string): Promise<ConversationQueue> {
  const inbox = await pi.snapshot(InboxDoc, conversationId(session), BACKGROUND)
  return Schema.decodeUnknownSync(ConversationQueue)({
    inputs: inbox?.items.filter((item) => item.mode !== 'write') ?? [],
  })
}

/** A shared browser stream may follow helpers and routines too; their queues are deliberately absent here. */
export const ownerQueue = (harness: PiHarness, thread: string) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const session = yield* attemptSync(() => conversations.require(thread))
    const kind = yield* attemptSync(() => conversations.kindOf(session))
    if (kind === 'subagent' || (yield* RoutineRuns).session(session) !== undefined) return { inputs: [] }
    return yield* attempt(async () => queuedInputs(await harness.pi(), session))
  })
