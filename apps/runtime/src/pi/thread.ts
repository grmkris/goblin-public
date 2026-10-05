import { GenerationTask, defineExtension, defineTool, hook, section } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import { Members, Conversations, attempt, requireBudget } from '../services.ts'
import type { RunProgram } from './resident-mcp.ts'

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
    name: 'purrable.thread',
    sections: [section('thread', () => THREAD)],
    tools: [
      defineTool({
        name: 'share_back',
        description:
          'Share a note from this thread with the conversation it branched from, only when the owner asks you to. That conversation sees it as context and does not answer it.',
        parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: 4000 }) }),
        // The write carries the call's id as its request id, so a rerun finds the same note.
        replay: 'safe',
        execute: async ({ note }, api) => {
          await run(Members.use((members) => attempt(() => members.require(String(api.conversationId)))))
          const parent = await run(
            Conversations.use((conversations) =>
              attempt(() => conversations.shareBack(String(api.conversationId), note, `share:${api.callId}`)),
            ),
          )
          return { content: [{ type: 'text', text: `Shared with ${parent}.` }] }
        },
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        // Fire and forget: naming never holds up the turn, and an untitled thread is retried on its next response.
        // Then a thread started with "+" tells main its name; that needs no model, so it waits on no budget, and a
        // thread the owner named before its first answer is announced too.
        afterResponse: (_message, api) => {
          const thread = String(api.conversationId)
          void run(
            Effect.gen(function* () {
              if ((yield* Members).access.origin(thread) !== undefined) return
              const conversations = yield* Conversations
              yield* Effect.ignore(
                requireBudget.pipe(Effect.andThen(attempt(() => conversations.nameIfUntitled(thread)))),
              )
              yield* attempt(() => conversations.announce(thread))
            }),
          ).catch(() => undefined)
        },
      }),
    ],
  })
}
