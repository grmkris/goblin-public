import {
  GenerationTask,
  ROOT_CONVERSATION_ID,
  type TaskId,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
} from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import { Conversations, Memory, attempt, requireBudget } from '../services.ts'
import type { RunProgram } from './resident-mcp.ts'

/** OptChat's view guide (§7.2), for Purrable: how to read the memory and when to zoom. Static, so caches hold. */
const GUIDE = [
  'Your memory of the main conversation: a request in it starts with the memory, inside <memory> tags, and then the',
  'recent messages in full. The memory holds the conversation before them, oldest first, as one-line summaries. Each',
  'line is `id+n|text`: the n messages from message id on, summarized. A summary tags each item with its kind: user',
  '(the owner, or another author it names), talk (your replies), tool (your tool calls), echo (their results) or work (a',
  "subagent's report). A short message is its own line, word for word. Recent lines cover one message each; the older",
  'the messages, the more a line covers.',
  '',
  '`zoom(id, n)` opens line id+n into the two lines of n/2 messages it was made from; `zoom(id, 1)` gives message id in',
  'full. Zoom whenever a summary only mentions something you need, such as a decision, a past attempt or where',
  'something is, before you act, guess or ask. Summaries keep little of tool output, so say in your reply what you',
  'learned that will matter later.',
].join('\n')

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
    name: 'purrable.memory-builder',
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

/** `zoom` into main's memory, bounded by what the conversation may see, and the guide to reading the view. */
function recallExtension(run: RunProgram) {
  return defineExtension({
    name: 'purrable.recall',
    sections: [section('memory', () => GUIDE)],
    tools: [
      defineTool({
        name: 'zoom',
        description:
          'Open the line id+n of your memory into the two lines of n/2 under it; n = 1 gives the message whole.',
        parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
        replay: 'safe',
        execute: async ({ id, n }, api) => {
          const text = await run(
            Effect.gen(function* () {
              const conversations = yield* Conversations
              const main = yield* Memory
              const limit = conversations.recallLimit(String(api.conversationId), main.size())
              return yield* attempt(() => main.zoom(id, n, limit))
            }),
          )
          return { content: [{ type: 'text', text }] }
        },
      }),
    ],
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
    name: 'purrable.memory',
    tasks: [BuilderTask],
    hooks: [
      hook(GenerationTask, {
        // Fire and forget: building never holds up the turn. A builder that ended in any way is replaced.
        afterResponse: () => {
          void run(
            Memory.use((main) =>
              attempt(() =>
                main.startBuilder(async (tx) => {
                  const state = await tx.doc(Builder, ROOT_CONVERSATION_ID)
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

  return { memory, recall: recallExtension(run) }
}
