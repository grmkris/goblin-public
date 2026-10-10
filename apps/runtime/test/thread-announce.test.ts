import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { Budget } from '../src/budget.ts'
import { ChatId } from '../src/chats/directory.ts'
import { Chats, Conversations } from '../src/chats/service.ts'
import type { AppError } from '../src/http/errors.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { threadExtension } from '../src/pi/thread.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { fake } from './fake.ts'

/** The thread extension's `afterResponse` for a thread whose announce writes a note (`announced`) or owes none. */
const afterResponse = (announced: boolean) => {
  const flows: FlowEvent[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(Chats, fake<typeof Chats.Service>({ chatOf: () => Effect.succeedSome(ChatId('12')) })),
    Layer.succeed(
      Conversations,
      fake<typeof Conversations.Service>({
        nameIfUntitled: () => Effect.void,
        announce: () => Effect.succeed(announced),
      }),
    ),
    Layer.succeed(Budget, fake<typeof Budget.Service>({ require: () => Effect.void })),
    FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
  )
  const runs: Promise<unknown>[] = []
  // SAFETY: the announce program reads only the services in `layer`.
  const run = ((program: Effect.Effect<unknown, AppError>) => {
    const ran = Effect.runPromise(program.pipe(Effect.provide(layer)))
    runs.push(ran)
    return ran
  }) as RunProgram
  const [registration] = threadExtension(run).hooks ?? []
  // SAFETY: the extension's one hook is GenerationTask's, and its `afterResponse` reads only the conversation id.
  const handlers = registration?.handlers as { readonly afterResponse: (...args: unknown[]) => void }
  const respond = async () => {
    handlers.afterResponse({}, { conversationId: 12 }, {})
    await Promise.all(runs)
    return flows
  }
  return respond
}

describe('thread announce flow (ADR 0037)', () => {
  it('records thread_announce when the announce wrote the note, and nothing when none was owed', async () => {
    expect(await afterResponse(true)()).toEqual([
      { flow: 'thread_announce', via: 'system', actor: 'agent', chat: '12', status: 'ok' },
    ])
    expect(await afterResponse(false)()).toEqual([])
  })
})
