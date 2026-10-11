import { PERSONAL_TOPIC, type RoutineDefinition } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { type NoticePost, Conversations } from '../../src/chats/service.ts'
import { noticesOf, routinesOf } from '../../src/layers/routines.ts'
import { McpServers } from '../../src/mcp/service.ts'
import { Notices } from '../../src/notices/service.ts'
import { NoticeStore } from '../../src/notices/store.ts'
import { notifyReport, postEventNotice, postReminder } from '../../src/routines/notices.ts'
import { Routines } from '../../src/routines/service.ts'
import { RoutineStore } from '../../src/routines/store.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { stub } from '../http/api/fixture.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

const EVENT: RoutineDefinition = {
  title: 'Picked',
  trigger: { kind: 'event', connectionId: 'sidequest', name: 'sidequest.inbox', arguments: {} },
  timezone: 'UTC',
  tellMe: { on: true, telegram: true },
  handTo: { kind: 'none' },
}

/** The notice programs over real notices and routines on SQLite, a home chat `5`, and a labelled connection. */
const world = () => {
  const database = chatDatabase()
  open.push(database)
  const db = durable(database.db)
  const notices = new NoticeStore(db)
  const routines = new RoutineStore(db, 'owner')
  const posted: NoticePost[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(Notices, noticesOf(notices)),
    Layer.succeed(Routines, routinesOf(routines)),
    stub(Conversations, {
      routineHome: (topic) => Effect.succeed({ chat: '5', topic }),
      postNotice: (notice) => Effect.sync(() => void posted.push(notice)),
    }),
    stub(McpServers, { labels: () => Effect.succeed(new Map([['sidequest', 'Sidequest · Worker']])) }),
  )
  const row = routines.propose(EVENT, 'op-1', 'rt_1', 1000, PERSONAL_TOPIC).routine
  const stored = routines.get(row.id)
  return {
    notices,
    posted,
    stored,
    run: <A, E>(program: Effect.Effect<A, E, Notices | Routines | Conversations | McpServers>) =>
      Effect.runPromise(Effect.provide(program, layer)),
  }
}

describe("a routine's notices (ADR 0041)", () => {
  it("posts an event's notice once, attributed to the connection and framed for the model", async () => {
    const { run, posted, notices, stored } = world()
    const event = { eventId: 'evt-1', name: 'sidequest.inbox', data: { title: 'You were picked' }, occurredAt: 2000 }
    await run(postEventNotice(stored, EVENT, event))
    await run(postEventNotice(stored, EVENT, event))
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      chat: '5',
      requestId: 'notice:rt_1:evt-1',
      data: {
        source: 'event',
        from: { label: 'Sidequest · Worker', connectionId: 'sidequest' },
        title: 'You were picked',
      },
    })
    expect(posted[0]?.text).toContain('untrusted data')
    expect(notices.get('notice:rt_1:evt-1')).toMatchObject({ telegramState: 'pending', writtenAt: expect.any(Number) })
  })

  it("posts a schedule's reminder from the routine, and points an answer's notification at its report", async () => {
    const { run, posted, notices, stored } = world()
    await run(postReminder(stored, { ...EVENT, trigger: { kind: 'cron', expression: '0 9 * * *' } }, 3000))
    expect(posted.at(-1)).toMatchObject({ data: { source: 'reminder', title: 'Picked', from: { label: 'Picked' } } })
    const handing: RoutineDefinition = {
      ...EVENT,
      handTo: {
        kind: 'goblin',
        instruction: 'Act on it.',
        allowedTools: [],
        budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
      },
    }
    await run(notifyReport(stored, handing, { runId: 'rr_1', text: 'Quoted on job 12.\nMore.', at: 4000 }))
    expect(notices.get('notice-report:rr_1')).toMatchObject({
      source: 'report',
      entryRequestId: 'routine-report:rr_1',
      title: 'Quoted on job 12.',
      writtenAt: expect.any(Number),
    })
    await run(
      notifyReport(
        stored,
        { ...handing, tellMe: { on: false, telegram: false } },
        { runId: 'rr_2', text: 'x', at: 5000 },
      ),
    )
    expect(notices.get('notice-report:rr_2')).toBeUndefined()
  })
})
