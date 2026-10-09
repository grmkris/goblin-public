import { GenerationTask, type TaskId, defineDoc, defineExtension, defineTask, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { requireBudget } from '../budget.ts'
import { Chats, Conversations, Moves } from '../chats/service.ts'
import { recallExtension } from '../memory/recall.ts'
import { Memories } from '../memory/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'

/** A Conversation's newest builder task: a new one starts only once it has ended. A move stops it (ADR 0034). */
export const MemoryBuilder = defineDoc<{ task: TaskId | null }>({
  kind: 'app.memory-builder',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ task: null }),
})

/**
 * The Topic's Conversation whose session `session` is now, or none: a thread, a subagent or a session that is no
 * chat's any more remembers nothing of its own.
 */
const conversationOf = (session: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const chat = Option.getOrUndefined(yield* chats.chatOf(session))
    if (chat === undefined || !(yield* chats.isConversation(chat))) return undefined
    return chat
  })

/**
 * The builder: one `ChatMemory` step per phase, for the Conversation it runs in, until caught up, the budget is spent
 * or a step fails.
 */
function builderTask(run: RunProgram) {
  // Each step commits a new checkpoint: Pi faults a phase that commits no durable progress.
  return defineTask<null, { readonly phase: 'step'; readonly steps: number }, null>({
    name: 'goblin.memory-builder',
    version: 1,
    initial: () => ({ phase: 'step', steps: 0 }),
    phases: {
      step: async (builder, runtime, context) => {
        const result = await run(
          Effect.gen(function* () {
            yield* requireBudget
            const chat = yield* conversationOf(String(runtime.conversationId))
            if (chat === undefined) return 'done' as const
            return yield* Memories.use((memories) => memories.step(chat, runtime.signal))
          }),
        ).catch((error: unknown) => {
          runtime.report(error)
          return 'done' as const
        })
        const steps = builder.state.checkpoint.steps + 1
        await runtime.commit(
          () =>
            result === 'more'
              ? { status: 'running', checkpoint: { phase: 'step', steps } }
              : { status: 'terminal', outcome: { status: 'completed', result: null } },
          context,
        )
      },
    },
    abort: (_builder, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

/**
 * Each Topic Conversation's memory as two extensions (ADR 0032). `memory` (Conversations only) keeps it built: after
 * every response it makes sure one background builder task runs there, which steps that Conversation's `ChatMemory`
 * until caught up, the budget is spent or a step fails (the next response starts another). `recall` (a Conversation and
 * the threads branched from it) explains the view and offers `zoom` into the Conversation above the caller.
 */
export function memoryExtensions(run: RunProgram) {
  const BuilderTask = builderTask(run)
  const memory = defineExtension({
    name: 'goblin.memory',
    tasks: [BuilderTask],
    hooks: [
      hook(GenerationTask, {
        // Fire and forget: building never holds up the turn. A builder that ended in any way is replaced.
        afterResponse: (_message, api) => {
          void run(
            Effect.gen(function* () {
              const chats = yield* Chats
              const chat = Option.getOrUndefined(yield* chats.chatOf(String(api.conversationId)))
              // A Conversation in the middle of a move (ADR 0034) builds nothing: its memory is cut to the moved turn.
              if (chat === undefined || (yield* Moves.use((moves) => moves.moving(chat)))) return
              if (!(yield* chats.isConversation(chat))) return
              yield* Memories.use((memories) =>
                memories.startBuilder(chat, async (tx) => {
                  const state = await tx.doc(MemoryBuilder, api.conversationId)
                  const last = state.task === null ? undefined : await tx.task(state.task)
                  if (last !== undefined && last.state.status !== 'terminal') return
                  state.task = await tx.createTask(BuilderTask, null, {
                    ownership: { kind: 'conversation' },
                    background: true,
                  })
                }),
              )
            }),
          ).catch(() => {
            // expected: the next response starts a builder again; run reported anything unexpected
          })
        },
      }),
    ],
  })

  return {
    memory,
    recall: recallExtension((id, n, conversation) =>
      run(
        Effect.gen(function* () {
          const chats = yield* Chats
          const memories = yield* Memories
          const chat = Option.getOrUndefined(yield* chats.chatOf(conversation))
          if (chat === undefined) return `No line ${id}+${n}.`
          const above = yield* chats.conversationAbove(chat)
          const size = yield* memories.size(above)
          const limit = yield* Conversations.use((conversations) => conversations.recallLimit(conversation, size))
          return yield* memories.zoom(above, { id, n }, limit)
        }),
      ),
    ),
  }
}
