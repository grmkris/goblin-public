import type { Harness, TaskGraphWatch } from '@earendil-works/pi-durable'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { Apps } from '../src/apps/service.ts'
import type { ChatId } from '../src/chats/directory.ts'
import { Chats, Conversations } from '../src/chats/service.ts'
import { Home } from '../src/home/service.ts'
import { Receipts } from '../src/organize/service.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Sidebar } from '../src/sidebar/service.ts'
import { Topics } from '../src/topics/service.ts'
import { Workspace, type WorkspaceEvent } from '../src/workspace/service.ts'
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

/** The workspace feed's sources but the decisions, the notices and the change bus, each empty, over Personal `1`. */
export const emptySources = Layer.mergeAll(
  // SAFETY: Personal's chat id, as the chat directory brands it.
  stub(Chats, { primary: '1' as ChatId, isHidden: () => Effect.succeed(false) }),
  stub(Conversations, { list: Effect.succeed([]) }),
  stub(Apps, { list: Effect.succeed([]) }),
  stub(Home, { layout: Effect.succeed({ revision: 0, tiles: [] }) }),
  stub(Topics, { list: Effect.succeed([]) }),
  stub(Personas, { list: Effect.succeed([]) }),
  stub(Invocations, { live: Effect.succeed([]) }),
  stub(Receipts, { list: () => Effect.succeed([]) }),
  stub(Sidebar, { read: Effect.succeed({ revision: 0, pins: [], seen: [] }) }),
  stub(PiSessions, { pi: Effect.succeed(pi) }),
)

/** The feed's first `count` events: its snapshot, then the changes `act` makes once the stream is open. */
export const feedEvents = <E, R>(count: number, act: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const opened = yield* Deferred.make<void>()
    const events = yield* (yield* Workspace).stream.pipe(
      Stream.tap(() => Deferred.succeed(opened, undefined)),
      Stream.take(count),
      Stream.runCollect,
      Effect.forkChild,
    )
    yield* Deferred.await(opened)
    yield* act
    const seen: readonly WorkspaceEvent[] = yield* Fiber.join(events)
    return seen
  })
