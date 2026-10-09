import type { TextContent } from '@earendil-works/pi-ai'
import type { Conversation, EntryId } from '@earendil-works/pi-durable'
import type { ThreadHeadData } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { type OwnerSubmit, submitOwner } from '../agent-program.ts'
import type { StartedThread } from '../env.ts'
import { InvalidInput } from '../http/errors.ts'
import { threadHeadContent } from '../pi/content.ts'
import { BACKGROUND } from '../pi/context.ts'
import { withinBudget } from './instance.ts'
import { ChatOperations, Conversations, type PassiveWrite } from './service.ts'

/** The most of the owner's words a thread head shows (`ThreadHeadData.text`). */
const HEAD_TEXT = 400

/**
 * The passive write of `app.thread_head`, request id `thread-head:<operation>` so a retry is the same entry. A moved
 * turn's head also omits that turn from the model's context there (`omit`, Pi edits).
 */
const threadHeadWrite = (
  head: ThreadHeadData,
  content: readonly TextContent[],
  omit: readonly EntryId[] = [],
): PassiveWrite => {
  const data = {
    thread: head.thread,
    text: head.text,
    operationId: head.operationId,
    ...(head.author === undefined ? {} : { author: head.author }),
    ...(head.moved === undefined ? {} : { moved: head.moved }),
  }
  const model = [{ role: 'user' as const, content: [...content], timestamp: Date.now() }]
  const edits = omit.map((target) => ({ target, action: 'omit' as const }))
  return {
    requestId: `thread-head:${head.operationId}`,
    entry: { kind: 'app.thread_head', data, model, ...(edits.length === 0 ? {} : { edits }) },
  }
}

/** Submits `app.thread_head` into `conversation` as a passive write (the mover, which holds the chat's lock). */
export async function submitThreadHead(
  conversation: Conversation,
  head: ThreadHeadData,
  content: readonly TextContent[],
  omit: readonly EntryId[] = [],
): Promise<void> {
  await conversation.submit({ type: 'write', ...threadHeadWrite(head, content, omit) }, BACKGROUND)
}

/**
 * Start thread (ADR 0034): the owner's message is posted as the head of a new Thread of `parent` and its reply lands
 * in that Thread. The Thread is made once per operation id (`ConversationRegistry.startThread`), the head is written
 * into `parent`, then the message goes into the Thread through the ordinary owner path (`submitOwner`), so its
 * attachments, App context and composer selections apply there. A retry with the same operation id repeats each step
 * idempotently and returns the same Thread and receipt.
 */
export const startThread = (input: Omit<OwnerSubmit, 'thread'> & { readonly parent: string }) =>
  Effect.gen(function* () {
    yield* withinBudget
    const skill = (input.context.selections ?? []).some((selection) => selection.kind === 'skill')
    if (input.text.trim() === '' && !skill) return yield* new InvalidInput({ reason: 'empty_message' })
    const conversations = yield* Conversations
    const thread = yield* conversations.startThread(input.parent, input.operationId)
    const head = { thread: thread.id, text: input.text.slice(0, HEAD_TEXT), operationId: input.operationId }
    // A passive write under the parent's admission lock: a busy parent places it at its next boundary.
    yield* (yield* ChatOperations).passiveWrite(input.parent, threadHeadWrite(head, threadHeadContent(input.text)))
    const receipt = yield* submitOwner({ ...input, thread: thread.id })
    const view = yield* conversations.view(thread.id)
    return { thread: Option.getOrElse(view, () => thread), receipt } satisfies StartedThread
  })
