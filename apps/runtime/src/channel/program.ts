import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { CHANNEL_TOOLS, DOORBELL_TOOLS, channelTool } from './channel.ts'
import { type Doorbell, doorbellValid, hookToken, hookUrl } from './doorbell.ts'
import { Channel } from './service.ts'
import { Forbidden, InvalidInput, attempt } from '../http/errors.ts'
import { offersEvents } from '../mcp/connection.ts'
import type { Consumer } from '../mcp/events/store.ts'
import { Events, McpConnections, McpGrants, McpServers } from '../mcp/service.ts'

const TELEGRAM_EVENTS = ['message.received', 'question.answered']

/** A promise step as `attempt` ran it: its typed failure, anything else `Internal`. */

const retirePrevious = (events: typeof Events.Service, bindings: readonly Option.Option<Consumer>[]) =>
  Effect.gen(function* () {
    for (const binding of bindings) if (Option.isSome(binding)) yield* events.unsubscribe(binding.value)
  })

/** Owner choice grants only the transport it selects. Fence the cursor after both Events leases confirm. */
export const enableTelegram = Effect.fn('channel.enable')(function* (
  serverId: string,
  appUrl: string,
  key: string,
  userId: string,
  wake: () => Promise<unknown>,
) {
  const connections = yield* McpConnections
  const channel = yield* Channel
  const events = yield* Events
  const tools = yield* McpServers.use((servers) => servers.tools(serverId, true))
  const snapshot = yield* connections.snapshot(serverId)
  const modern = Option.isSome(snapshot) && offersEvents(snapshot.value)
  const required = modern ? CHANNEL_TOOLS : [...CHANNEL_TOOLS, ...DOORBELL_TOOLS]
  const missing = required.filter((name) => !tools.some((tool) => tool.name === name))
  if (missing.length > 0) return yield* new InvalidInput({ reason: `${serverId} does not offer ${missing.join(', ')}` })
  const grants = yield* McpGrants
  for (const name of required) yield* grants.setTool(serverId, name, true)
  if (!modern) {
    const url = hookUrl(appUrl, userId, yield* attempt(() => hookToken(key, userId)))
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    return yield* channel.enable(serverId, url, channelTool(connections, serverId), now)
  }
  const cursor = yield* channel.startCursor(serverId, channelTool(connections, serverId))
  const revision = yield* Clock.currentTimeMillis
  const previous: Option.Option<Consumer>[] = []
  for (const name of TELEGRAM_EVENTS) {
    const current = (yield* channel.status)?.serverId ?? serverId
    previous.push(yield* events.activeConsumer(`telegram:${current}:${name}`))
  }
  for (const name of TELEGRAM_EVENTS) {
    yield* events.grant(serverId, name, {}, true)
    yield* events.subscribe({
      consumerId: `telegram:${serverId}:${name}`,
      revision,
      serverId,
      name,
      arguments: {},
      handlerKey: 'telegram-inbox',
    })
  }
  const status = yield* channel.enableEvents(serverId, cursor, Math.floor((yield* Clock.currentTimeMillis) / 1000))
  yield* retirePrevious(events, previous)
  yield* attempt(wake)
  return status
})

export const disableTelegram = Effect.gen(function* () {
  const channel = yield* Channel
  const events = yield* Events
  const status = yield* channel.status
  for (const name of TELEGRAM_EVENTS) {
    const binding = yield* events.activeConsumer(`telegram:${status?.serverId}:${name}`)
    if (Option.isSome(binding)) yield* events.unsubscribe(binding.value)
  }
  if (status !== null && status.transport === 'doorbell') {
    const connections = yield* McpConnections
    // expected: the doorbell is off on this side whatever myagent answers; a later ring finds no secret.
    yield* Effect.ignore(channelTool(connections, status.serverId)('unsubscribe', {}))
  }
  yield* channel.disable
  return null
})

/** Verify a channel's doorbell before scheduling its pull; it never renews resident authority. */
export const acceptDoorbell = Effect.fn('channel.acceptDoorbell')(function* (
  doorbell: Doorbell,
  pull: () => Promise<unknown>,
) {
  const channel = yield* Channel
  const secret = yield* channel.secret
  const now = yield* Clock.currentTimeMillis
  const valid = secret !== undefined && (yield* attempt(() => doorbellValid(secret, doorbell, now)))
  if (!valid) return yield* new Forbidden({ reason: 'doorbell' })
  yield* attempt(pull)
  return true as const
})
