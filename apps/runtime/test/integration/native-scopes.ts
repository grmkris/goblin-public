import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'

const Scope = Schema.Struct({
  editable: Schema.Boolean,
  mail: Schema.Boolean,
  send: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  skills: Schema.Boolean,
  subagents: Schema.Boolean,
})
const Scopes = Schema.Struct({
  thread: Scope,
  deep: Scope,
  orphan: Scope,
  unknown: Scope,
  deepest: Scope,
  cycle: Scope,
  fromSubagent: Scope,
  serverBackOn: Scope,
  afterReset: Scope,
  own: Schema.Array(Schema.Unknown),
  retooled: Schema.Array(Schema.String),
  once: Schema.Array(Schema.String),
  again: Schema.Number,
})
const closed = { editable: false, mail: false, send: false, read: false, write: false, skills: false, subagents: false }

/**
 * A thread copies its parent's switches, a subagent is bounded by every conversation above it, and stored tool filters
 * are applied again once (`CapabilityProfiles.retoolOnce`).
 */
export const scopesCase = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(`${url.replace(/\/+$/u, '')}/scopes?name=scopes-${Date.now()}`))
    const result = yield* Schema.decodeUnknownEffect(Scopes)(yield* Effect.promise(() => response.json()))
    const thread = { editable: true, mail: false, send: false, read: true, write: false, skills: true, subagents: true }
    expect(result.thread).toEqual(thread)
    expect(result.deep).toEqual({ ...thread, editable: false, skills: false })
    expect(result.orphan).toEqual(closed)
    expect(result.unknown).toEqual(closed)
    expect(result.deepest).toEqual({ ...thread, editable: false })
    expect(result.cycle).toEqual(closed)
    expect(result.fromSubagent).toEqual({ ...thread, skills: false })
    // A server switched back on keeps the tool switched off under it.
    expect(result.serverBackOn).toEqual({ ...thread, mail: true })
    expect(result.afterReset).toEqual({ ...thread, mail: true, send: true })
    expect(result.own).toEqual([{ kind: 'tool', serverId: 'notes', name: 'write' }])
    expect(result.retooled).toEqual(['900'])
    expect(result.once).toEqual(['903', '950', '951', '960'])
    expect(result.again).toBe(0)
  })
