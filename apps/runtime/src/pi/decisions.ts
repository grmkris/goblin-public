import { GenerationTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Option from 'effect/Option'
import { Decisions } from '../decisions/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { withContext } from './context-tail.ts'

/**
 * Typed decisions in the owner's chats (ADR 0031); helpers and routine runs never install this extension. After a
 * final answer the exchange is judged, in the background; before each request, earlier work the owner chose to use in
 * the chat joins goblin's context block (for that request only, never the transcript). A failure changes neither.
 * Without Clef (`judging` false: the stage binds no `AI`) the hooks do nothing at all.
 */
export function decisionsExtension(run: RunProgram, judging: boolean) {
  return defineExtension({
    name: 'goblin.decisions',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          if (!judging) return undefined
          const session = String(api.conversationId)
          // expected: a request without the chosen work is the turn as it was; run reported anything unexpected
          const chosen = await run(Decisions.use((decisions) => decisions.chosenContext(session))).catch(() =>
            Option.none<string>(),
          )
          return Option.isNone(chosen) ? undefined : { messages: withContext(messages, 'chosen-context', chosen.value) }
        },
        onYield: (_answer, api) => {
          if (!judging) return undefined
          void run(Decisions.use((decisions) => decisions.afterYield(String(api.conversationId)))).catch(() => {
            // expected: judging is optional side work that never fails the turn; run reported anything unexpected
          })
          return undefined
        },
      }),
    ],
  })
}
