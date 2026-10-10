import type { Harness, TaskGraphWatch } from '@earendil-works/pi-durable'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'
import { Apps } from '../src/apps/service.ts'
import type { ChatId } from '../src/chats/directory.ts'
import { Chats, Conversations } from '../src/chats/service.ts'
import { Decisions } from '../src/decisions/service.ts'
import { Home } from '../src/home/service.ts'
import { Receipts } from '../src/organize/service.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Changes } from '../src/runtime/changes.ts'
import { Topics } from '../src/topics/service.ts'
import { WorkspaceLive } from '../src/workspace/live.ts'
import { Workspace, type WorkspaceEvent } from '../src/workspace/service.ts'
import { answering, decisionsFixture, entry } from './decisions-services.ts'
import { stub } from './http/api/fixture.ts'

/** Pi as the feed reads it: an empty task graph. */
// SAFETY: the feed asks Pi only to watch its task graph.
const pi = Object.assign(Object.create(null) as Harness, {
  watchTaskGraph: async () =>
    // SAFETY: the feed reads the watch's first graph, starts it and stops it; the graph stays empty.
    Object.assign(Object.create(null) as TaskGraphWatch, {
      value: { tasks: {} },
      start: () => undefined,
      stop: async () => undefined,
    }),
})

/** The workspace feed over the real decisions and their change bus, every other source empty. */
async function feed() {
  const f = decisionsFixture()
  f.sqlite.exec(
    "INSERT INTO app_conversations (session_id, pi_session, role, kind, created_at, topic_id) VALUES ('1', '1', 'primary', 'main', 1, 1)",
  )
  f.say('1', entry(2, '1', 'pi.user', 'Compare the trip options'), entry(3, '1', 'pi.assistant', 'Both are fine.'))
  f.state.answer = answering((_question, option) => (option === 'highlight' ? 0.85 : 0.05))
  const decisions = await f.run(Decisions.use(Effect.succeed))
  const changes = await f.run(Changes.use(Effect.succeed))
  const sources = Layer.mergeAll(
    Layer.succeed(Decisions, decisions),
    Layer.succeed(Changes, changes),
    // SAFETY: Personal's chat id, as the chat directory brands it.
    stub(Chats, { primary: '1' as ChatId, isHidden: () => Effect.succeed(false) }),
    stub(Conversations, { list: Effect.succeed([]) }),
    stub(Apps, { list: Effect.succeed([]) }),
    stub(Home, { layout: Effect.succeed({ revision: 0, tiles: [] }) }),
    stub(Topics, { list: Effect.succeed([]) }),
    stub(Personas, { list: Effect.succeed([]) }),
    stub(Invocations, { live: Effect.succeed([]) }),
    stub(Receipts, { list: () => Effect.succeed([]) }),
    stub(PiSessions, { pi: Effect.succeed(pi) }),
  )
  return { ...f, layer: Layer.provideMerge(WorkspaceLive, sources) }
}

describe('decision proposals in the workspace feed', () => {
  it('carries the open and confirmed proposals in its snapshot, and each one made or labelled as a change', async () => {
    const f = await feed()
    await f.run(
      Decisions.use((decisions) =>
        decisions.afterReport({ session: '1', relayId: 'r1', text: 'A useful update.', complete: true }),
      ),
    )
    const program = Effect.gen(function* () {
      const opened = yield* Deferred.make<void>()
      const events = yield* (yield* Workspace).stream.pipe(
        Stream.tap(() => Deferred.succeed(opened, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* Deferred.await(opened)
      const decisions = yield* Decisions
      yield* decisions.afterReport({ session: '1', relayId: 'r2', text: 'Another useful update.', complete: true })
      yield* decisions.label('dp_report_r1', 'dismiss')
      const seen: readonly WorkspaceEvent[] = yield* Fiber.join(events)
      return seen
    })
    const [snapshot, ...changes] = await Effect.runPromise(program.pipe(Effect.provide(f.layer)))
    expect(snapshot).toMatchObject({ event: 'snapshot', data: { proposals: [{ id: 'dp_report_r1', state: 'open' }] } })
    expect(changes).toEqual([
      {
        event: 'change',
        data: [
          expect.objectContaining({
            type: 'proposal',
            proposal: expect.objectContaining({ id: 'dp_report_r2', state: 'open' }),
          }),
        ],
      },
      {
        event: 'change',
        data: [
          expect.objectContaining({
            type: 'proposal',
            proposal: expect.objectContaining({ id: 'dp_report_r1', state: 'dismissed' }),
          }),
        ],
      },
    ])
  })
})
