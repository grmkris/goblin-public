import type { TextContent } from '@earendil-works/pi-ai'
import type { Conversation, EntryId } from '@earendil-works/pi-durable'
import type { StartedThread, ThreadHeadData } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { type OwnerSubmit, submitOwner } from '../agent-program.ts'
import { InvalidInput } from '../http/errors.ts'
import { threadHeadContent } from '../pi/content.ts'
import { BACKGROUND } from '../pi/context.ts'
import { admitTurn } from '../budget.ts'
import { ChatOperations, Conversations, type PassiveWrite, type ThreadAnchor } from './service.ts'

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
 * The unified thread operation (ADR 0034): Reply on a message, "+" and Start thread. The Thread is made once per
 * operation id (`Conversations.startThread`, at `anchor`); a Start thread from the composer (`latest`) posts the owner's
 * message as the Thread's head in `parent`. Then the message goes into the Thread through the ordinary owner path
 * (`submitOwner`) as the operation's first message, `<operation>:first`, so its attachments, App context, composer
 * selections and Persona order apply there. A retry with the same operation id repeats each step idempotently and
 * returns the same Thread and receipt.
 */
export const startThread = (
  input: Omit<OwnerSubmit, 'thread' | 'parentOp'> & { readonly parent: string; readonly anchor: ThreadAnchor },
) =>
  Effect.gen(function* () {
    yield* admitTurn
    const skill = (input.context.selections ?? []).some((selection) => selection.kind === 'skill')
    if (input.text.trim() === '' && !skill) return yield* new InvalidInput({ reason: 'empty_message' })
    const conversations = yield* Conversations
    const { parent, anchor, operationId } = input
    const thread = yield* conversations.startThread(parent, operationId, anchor)
    if (anchor === 'latest') {
      const head = { thread: thread.id, text: input.text.slice(0, HEAD_TEXT), operationId }
      const write = threadHeadWrite(head, threadHeadContent(input.text))
      // A passive write under the parent's admission lock: a busy parent places it at its next boundary.
      yield* (yield* ChatOperations).passiveWrite(parent, { ...write, origin: 'owner', parentOp: operationId })
    }
    const first = { thread: thread.id, operationId: firstOperation(operationId), parentOp: operationId }
    const receipt = yield* submitOwner({ ...input, ...first })
    const view = yield* conversations.view(thread.id)
    return { thread: Option.getOrElse(view, () => thread), receipt } satisfies StartedThread
  })

/** The operation id of a thread operation's first message. */
export const firstOperation = (operationId: string): string => `${operationId}:first`
