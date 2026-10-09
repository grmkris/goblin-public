import type { TextContent } from '@earendil-works/pi-ai'
import type { Conversation, EntryId } from '@earendil-works/pi-durable'
import type { ThreadHeadData } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import { type OwnerSubmit, submitOwner } from '../agent-program.ts'
import type { StartedThread } from '../env.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { threadHeadContent } from '../pi/content.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { Chats, Conversations, attempt, nowSecondsEffect, requireBudget } from '../services.ts'
import type { ChatDirectory } from './directory.ts'

/** The most of the owner's words a thread head shows (`ThreadHeadData.text`). */
const HEAD_TEXT = 400

/**
 * Submits `app.thread_head` into `conversation` as a passive write, request id `thread-head:<operation>`. A moved
 * turn's head also omits that turn from the model's context there (`omit`, Pi edits).
 */
export async function submitThreadHead(
  conversation: Conversation,
  head: ThreadHeadData,
  content: readonly TextContent[],
  omit: readonly EntryId[] = [],
): Promise<void> {
  const data = {
    thread: head.thread,
    text: head.text,
    operationId: head.operationId,
    ...(head.author === undefined ? {} : { author: head.author }),
    ...(head.moved === undefined ? {} : { moved: head.moved }),
  }
  const model = [{ role: 'user' as const, content: [...content], timestamp: Date.now() }]
  const edits = omit.map((target) => ({ target, action: 'omit' as const }))
  const entry = { kind: 'app.thread_head', data, model, ...(edits.length === 0 ? {} : { edits }) }
  await conversation.submit({ type: 'write', requestId: `thread-head:${head.operationId}`, entry }, BACKGROUND)
}

/**
 * Writes `app.thread_head` into `chat`: the head of a Thread that started there, which the web draws with the
 * Thread's replies under it. A passive write (it starts no run) under the chat's admission lock, so a busy chat places
 * it at its next boundary; the request id `thread-head:<operation>` makes a retry the same entry.
 */
async function writeThreadHead(
  harness: PiHarness,
  chats: ChatDirectory,
  chat: string,
  head: ThreadHeadData,
  content: readonly TextContent[],
): Promise<void> {
  await chats.passiveWrite(chat, async (session) => {
    const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'conversation' })
    await submitThreadHead(conversation, head, content)
  })
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
    yield* requireBudget
    const skill = (input.context.selections ?? []).some((selection) => selection.kind === 'skill')
    if (input.text.trim() === '' && !skill) return yield* new InvalidInput({ reason: 'empty_message' })
    const conversations = yield* Conversations
    const chats = yield* Chats
    const now = yield* nowSecondsEffect
    const thread = yield* attempt(() => conversations.startThread(input.parent, input.operationId, now))
    const head = { thread: thread.id, text: input.text.slice(0, HEAD_TEXT), operationId: input.operationId }
    const content = threadHeadContent(input.text)
    yield* attempt(() => writeThreadHead(input.harness, chats, input.parent, head, content))
    const receipt = yield* submitOwner({ ...input, thread: thread.id })
    const view = yield* attempt(() => conversations.view(thread.id))
    return { thread: view ?? thread, receipt } satisfies StartedThread
  })
