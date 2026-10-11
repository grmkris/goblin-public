import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { Decisions } from '../src/decisions/service.ts'
import { Notices } from '../src/notices/service.ts'
import { Changes } from '../src/runtime/changes.ts'
import { WorkspaceLive } from '../src/workspace/live.ts'
import { answering, decisionsFixture, entry } from './decisions-services.ts'
import { stub } from './http/api/fixture.ts'
import { emptySources, feedEvents } from './workspace-sources.ts'

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
    stub(Notices, { views: Effect.succeed([]) }),
    Layer.succeed(Changes, changes),
    emptySources,
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
    const program = feedEvents(
      3,
      Effect.gen(function* () {
        const decisions = yield* Decisions
        yield* decisions.afterReport({ session: '1', relayId: 'r2', text: 'Another useful update.', complete: true })
        yield* decisions.label('dp_report_r1', 'dismiss')
      }),
    )
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
