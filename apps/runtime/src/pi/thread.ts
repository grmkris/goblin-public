import { GenerationTask, defineExtension, hook, section } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Chats, Conversations, attempt, requireBudget } from '../services.ts'
import type { RunProgram } from './resident-mcp.ts'
import { NotFound } from '../http/errors.ts'
import { Entitlements } from '../billing/gates.ts'
import { typedTool } from './typed-tool.ts'

const THREAD = [
  'This is a side thread, apart from the conversation it branched from (your main conversation with the owner, unless',
  'it branched from another thread or a subagent). Nothing said here reaches that conversation unless the owner asks',
  'you to share it; then call `share_back` with a short note of what was decided or found, written so it stands on its',
  'own there.',
].join(' ')

/**
 * What a side thread adds: knowing it is one, `share_back` (a note written into the conversation it came from, which
 * the model there sees without starting a run), and a title the cheap model writes after the first exchange.
 */
export function threadExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.thread',
    sections: [section('thread', () => THREAD)],
    tools: [
      typedTool({
        name: 'share_back',
        description:
          'Share a note from this thread with the conversation it branched from, only when the owner asks you to. That conversation sees it as context and does not answer it.',
        input: Schema.Struct({ note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)) }),
        output: Schema.Struct({ sharedWith: Schema.String }),
        // The write carries the call's id as its request id, so a rerun finds the same note.
        replay: 'safe',
        execute: async ({ note }, api) => {
          await run(Entitlements.use((plans) => plans.require()))
          const parent = await run(
            Effect.gen(function* () {
              const chat = (yield* Chats).chatOf(String(api.conversationId))
              if (chat === undefined) return yield* new NotFound({ what: 'chat' })
              return yield* Conversations.use((conversations) =>
                attempt(() => conversations.shareBack(chat, note, `share:${api.callId}`)),
              )
            }),
          )
          return { sharedWith: parent }
        },
        text: ({ sharedWith }) => `Shared with ${sharedWith}.`,
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        // Fire and forget: naming never holds up the turn, and an untitled thread is retried on its next response.
        // Then a thread started with "+" tells main its name; that needs no model, so it waits on no budget, and a
        // thread the owner named before its first answer is announced too.
        afterResponse: (_message, api) => {
          const thread = String(api.conversationId)
          const announce = Effect.gen(function* () {
            const conversations = yield* Conversations
            const chat = (yield* Chats).chatOf(thread)
            if (chat === undefined) return
            // expected: a spent budget or a failed name leaves the thread untitled, retried on its next response.
            yield* Effect.ignore(requireBudget.pipe(Effect.andThen(attempt(() => conversations.nameIfUntitled(chat)))))
            yield* attempt(() => conversations.announce(chat))
          })
          // expected: the bridge reports an unexpected failure; a refusal (plan, authority) only means no announce.
          void run(announce).catch(() => undefined)
        },
      }),
    ],
  })
}
