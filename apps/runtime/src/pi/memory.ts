import { recallExtension } from '../memory/recall.ts'
import { GenerationTask, type TaskId, defineDoc, defineExtension, defineTask, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { Conversations, Memory, attempt, requireBudget } from '../services.ts'
import type { RunProgram } from './resident-mcp.ts'

/** Main's newest builder task: a new one starts only once it has ended. */
const Builder = defineDoc<{ task: TaskId | null }>({
  kind: 'app.memory-builder',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ task: null }),
})

/** The builder: one `MainMemory` step per phase until caught up, the budget is spent or a step fails. */
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
            const memory = yield* Memory
            return yield* attempt(() => memory.step(runtime.signal))
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
 * Main's memory as two extensions. `memory` (main only) keeps it built: after every response it makes sure one
 * background builder task runs, which steps `MainMemory` until caught up, the budget is spent or a step fails (the
 * next response starts another). `recall` (main and the threads branched from it) explains the view and offers `zoom`.
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
            Memory.use((main) =>
              attempt(() =>
                main.startBuilder(async (tx) => {
                  const state = await tx.doc(Builder, api.conversationId)
                  const last = state.task === null ? undefined : await tx.task(state.task)
                  if (last !== undefined && last.state.status !== 'terminal') return
                  state.task = await tx.createTask(BuilderTask, null, {
                    ownership: { kind: 'conversation' },
                    background: true,
                  })
                }),
              ),
            ),
          ).catch(() => undefined)
        },
      }),
    ],
  })

  return {
    memory,
    recall: recallExtension((id, n, conversation) =>
      run(
        Effect.gen(function* () {
          const conversations = yield* Conversations
          const main = yield* Memory
          return yield* attempt(() => main.zoom(id, n, conversations.recallLimit(conversation, main.size())))
        }),
      ),
    ),
  }
}
