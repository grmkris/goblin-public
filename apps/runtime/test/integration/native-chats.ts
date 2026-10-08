import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

const Proof = Schema.Struct({
  session: Schema.String,
  settledSession: Schema.String,
  rootMessages: Schema.Number,
  primaryMessages: Schema.Number,
  inboundStatus: Schema.String,
  inboundSession: Schema.String,
  recentInbound: Schema.Boolean,
})

/** Owner admission, inbound wait and recent-message reads all follow chat 1's non-root Pi binding. */
export const primaryBindingCase = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/primary-profile?name=primary-proof`, {
        headers: { connection: 'close' },
      }),
    )
    expect(response.status).toBe(200)
    const result = yield* Schema.decodeUnknownEffect(Proof)(yield* Effect.promise(() => response.json()))
    expect(result.session).not.toBe('1')
    expect(result.settledSession).toBe(result.session)
    expect(result.inboundStatus).toBe('done')
    expect(result.inboundSession).toBe(result.session)
    expect(result.recentInbound).toBe(true)
    expect(result.rootMessages).toBe(0)
    expect(result.primaryMessages).toBeGreaterThan(0)
  })
