import { describe, expect, it } from '@effect/vitest'
import type { AgentEventStream, Harness } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { PiFailure, PiSessions } from '../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { fake } from './fake.ts'

/** The service over a harness whose opened Pi is `opened` and whose sessions' event streams are `streams`. */
const sessionsOver = (opened: Harness, streams: (session: string) => Promise<AgentEventStream>) => {
  const harness = fake<PiHarness>({
    pi: async () => opened,
    // The events call asks a session for its event stream only.
    session: (session?: string) => fake<ReturnType<PiHarness['session']>>({ events: () => streams(session ?? 'root') }),
  })
  return PiSessions.layer.pipe(Layer.provide(Layer.succeed(AgentInput, fake<AgentInputs>({ harness }))))
}

describe('Pi sessions', () => {
  it.effect("hand over Pi's opened harness and a named session's event stream", () => {
    const opened = fake<Harness>({})
    const stream = fake<AgentEventStream>({})
    const asked: string[] = []
    const layer = sessionsOver(opened, async (session) => {
      asked.push(session)
      return stream
    })
    return Effect.gen(function* () {
      const pi = yield* PiSessions
      expect(yield* pi.pi).toBe(opened)
      expect(yield* pi.events('42')).toBe(stream)
      expect(asked).toEqual(['42'])
    }).pipe(Effect.provide(layer))
  })

  it.effect("take Pi's failure to open a session's events as a PiFailure naming the call", () => {
    const layer = sessionsOver(fake<Harness>({}), () => Promise.reject(new Error('closed')))
    return Effect.gen(function* () {
      const failure = yield* Effect.flip((yield* PiSessions).events('42'))
      expect(failure).toBeInstanceOf(PiFailure)
      expect(failure.operation).toBe('events')
    }).pipe(Effect.provide(layer))
  })
})
