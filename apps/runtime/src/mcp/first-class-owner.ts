import type { WalletStatus } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { NotFound } from '../http/errors.ts'
import { profileOf } from './first-class.ts'
import { McpConnections, McpGrants } from './service.ts'

// What the owner does with a first-class server (ADR 0043): allow its recommended grants in one go, and read its status
// line. Both are the owner's own acts, through the owner API.

/** The profile of connection `connectionId`'s server; `NotFound` for one goblin does not support first-class. */
const profileFor = (connectionId: string) =>
  Effect.gen(function* () {
    const server = yield* (yield* McpConnections).server(connectionId)
    const profile = profileOf(server.endpoint)
    if (profile === undefined) return yield* new NotFound({ what: `profile for ${connectionId}` })
    return profile
  })

/**
 * Applies a first-class server's recommended grants: its free tools run when needed, its paid ones ask first. A tool
 * the server does not list now is skipped (it may come with a role the agent does not have yet).
 */
export const allowRecommended = (connectionId: string) =>
  Effect.gen(function* () {
    const profile = yield* profileFor(connectionId)
    const grants = yield* McpGrants
    const allow = (name: string) =>
      grants.setTool(connectionId, name, true).pipe(
        Effect.as(true),
        // expected: a tool the server does not list now is not allowed, and the rest still are
        Effect.catchTag('NotFound', () => Effect.succeed(false)),
      )
    for (const name of profile.recommended.run) yield* allow(name)
    for (const name of profile.recommended.ask)
      if (yield* allow(name)) yield* grants.setAskFirst(connectionId, name, true)
    return yield* grants.list()
  })

/**
 * A first-class server's status line, read from its status tool as the owner: null until the owner allowed that tool,
 * or when what the server answers does not fit goblin's schema for it.
 */
export const serverStatus = (connectionId: string) =>
  Effect.gen(function* () {
    const { statusTool } = yield* profileFor(connectionId)
    if (statusTool === undefined) return null
    const result = yield* (yield* McpConnections)
      .callTool(connectionId, statusTool.name, {}, { caller: 'human' })
      // expected: a status line is optional: not allowed yet, signed out or unreachable, the card shows none
      .pipe(Effect.option)
    if (Option.isNone(result) || result.value.isError === true) return null
    const read: WalletStatus | undefined = statusTool.read(result.value.structuredContent)
    return read ?? null
  })
