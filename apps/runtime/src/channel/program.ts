import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import { CHANNEL_TOOLS, DOORBELL_TOOLS, channelCall } from './channel.ts'
import { type Doorbell, doorbellValid, hookToken, hookUrl } from './doorbell.ts'
import { Forbidden, InvalidInput } from '../http/errors.ts'
import { offersEvents } from '../mcp/connection.ts'
import type { Consumer } from '../mcp/events/store.ts'
import { Events, type McpEvents } from '../mcp/events.ts'
import { Channel, Mcp, attempt, nowSecondsEffect } from '../services.ts'

const retirePrevious = (events: McpEvents, bindings: readonly (Consumer | undefined)[]) =>
  Effect.gen(function* () {
    for (const binding of bindings) if (binding !== undefined) yield* events.unsubscribe(binding)
  })

/** Owner choice grants only the transport it selects. Fence the cursor after both Events leases confirm. */
export const enableTelegram = (
  serverId: string,
  appUrl: string,
  key: string,
  userId: string,
  wake: () => Promise<unknown>,
) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp
    const channel = yield* Channel
    const events = yield* Events
    const tools = yield* attempt(() => mcp.tools(serverId, true))
    const snapshot = mcp.manager.snapshot(serverId)
    const modern = snapshot !== undefined && offersEvents(snapshot)
    const required = modern ? CHANNEL_TOOLS : [...CHANNEL_TOOLS, ...DOORBELL_TOOLS]
    const missing = required.filter((name) => !tools.some((tool) => tool.name === name))
    if (missing.length > 0)
      return yield* new InvalidInput({ reason: `${serverId} does not offer ${missing.join(', ')}` })
    for (const name of required) yield* attempt(() => mcp.setToolGrant(serverId, name, true))
    if (!modern) {
      const url = hookUrl(appUrl, userId, yield* attempt(() => hookToken(key, userId)))
      return yield* attempt(() =>
        channel.enable(serverId, url, channelCall(mcp.manager, serverId), Math.floor(Date.now() / 1000)),
      )
    }
    const cursor = yield* attempt(() => channel.startCursor(serverId, channelCall(mcp.manager, serverId)))
    const revision = yield* Clock.currentTimeMillis
    const previous = ['message.received', 'question.answered'].map((name) =>
      events.store.activeConsumer(`telegram:${channel.status()?.serverId ?? serverId}:${name}`),
    )
    for (const name of ['message.received', 'question.answered']) {
      events.grant(serverId, name, {}, true)
      yield* events.subscribe({
        consumerId: `telegram:${serverId}:${name}`,
        revision,
        serverId,
        name,
        arguments: {},
        handlerKey: 'telegram-inbox',
      })
    }
    const status = channel.enableEvents(serverId, cursor, yield* nowSecondsEffect)
    yield* retirePrevious(events, previous)
    yield* attempt(wake)
    return status
  })

export const disableTelegram = Effect.gen(function* () {
  const mcp = yield* Mcp
  const channel = yield* Channel
  const events = yield* Events
  const status = channel.status()
  for (const name of ['message.received', 'question.answered']) {
    const binding = events.store.activeConsumer(`telegram:${status?.serverId}:${name}`)
    if (binding !== undefined) yield* events.unsubscribe(binding)
  }
  if (status !== null && status.transport === 'doorbell')
    yield* Effect.ignore(attempt(() => channelCall(mcp.manager, status.serverId)('unsubscribe', {})))
  channel.disable()
  return null
})

/** Verify a channel's doorbell before scheduling its pull; it never renews resident authority. */
export const acceptDoorbell = (doorbell: Doorbell, pull: () => Promise<unknown>) =>
  Effect.gen(function* () {
    const channel = yield* Channel
    const secret = yield* attempt(() => channel.secret())
    const now = yield* Clock.currentTimeMillis
    const valid = secret !== undefined && (yield* attempt(() => doorbellValid(secret, doorbell, now)))
    if (!valid) return yield* new Forbidden({ reason: 'doorbell' })
    yield* attempt(pull)
    return true as const
  })
