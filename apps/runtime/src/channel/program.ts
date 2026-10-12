import { TELEGRAM_EVENTS, telegramEvent, telegramTools } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { DOORBELL_TOOLS, channelTool } from './channel.ts'
import { type Doorbell, doorbellValid, hookToken, hookUrl } from './doorbell.ts'
import { Channel } from './service.ts'
import { Forbidden, InvalidInput, attempt } from '../http/errors.ts'
import { offersEvents } from '../mcp/remote.ts'
import type { Consumer } from '../mcp/events/store.ts'
import { Events, McpConnections, McpGrants, McpServers } from '../mcp/service.ts'
import { epochSeconds } from '../clock.ts'
import { AgentInput } from '../runtime/input.ts'

/** The consumer of one Telegram Event: keyed by mygram's own event name, whichever spelling the server uses. */
const consumerOf = (connectionId: string | undefined, event: string) => `telegram:${connectionId}:${event}`

/**
 * The Telegram Events as `connectionId` names them (mygram's own, or mysi's `mygram.` ones), from the Events it lists;
 * InvalidInput naming one it does not offer.
 */
const telegramEvents = (events: typeof Events.Service, connectionId: string) =>
  Effect.gen(function* () {
    const offered = new Set((yield* events.catalog(connectionId)).map(({ name }) => name))
    const named: { readonly event: string; readonly name: string }[] = []
    for (const event of TELEGRAM_EVENTS) {
      const name = telegramEvent(offered, event)
      if (name === undefined) return yield* new InvalidInput({ reason: `${connectionId} does not offer ${event}` })
      named.push({ event, name })
    }
    return named
  })

const retirePrevious = (events: typeof Events.Service, bindings: readonly Option.Option<Consumer>[]) =>
  Effect.gen(function* () {
    for (const binding of bindings) if (Option.isSome(binding)) yield* events.unsubscribe(binding.value)
  })

/** Owner choice grants only the transport it selects. Fence the cursor after both Events leases confirm. */
export const enableTelegram = Effect.fn('channel.enable')(function* (
  connectionId: string,
  appUrl: string,
  key: string,
  userId: string,
  wake: () => Promise<unknown>,
) {
  const connections = yield* McpConnections
  const channel = yield* Channel
  const events = yield* Events
  const tools = (yield* McpServers.use((servers) => servers.tools(connectionId, true))).map(({ name }) => name)
  const snapshot = yield* connections.snapshot(connectionId)
  const modern = Option.isSome(snapshot) && offersEvents(snapshot.value)
  const channelTools = telegramTools(tools)
  if (channelTools === undefined)
    return yield* new InvalidInput({ reason: `${connectionId} does not offer Telegram's inbox_read and message_send` })
  const missing = modern ? [] : DOORBELL_TOOLS.filter((name) => !tools.includes(name))
  if (missing.length > 0)
    return yield* new InvalidInput({ reason: `${connectionId} does not offer ${missing.join(', ')}` })
  const named = modern ? yield* telegramEvents(events, connectionId) : []
  const required = [channelTools.inbox, channelTools.send, ...(modern ? [] : DOORBELL_TOOLS)]
  const grants = yield* McpGrants
  for (const name of required) yield* grants.setTool(connectionId, name, true)
  if (!modern) {
    const url = hookUrl(appUrl, userId, yield* attempt(() => hookToken(key, userId)))
    const now = yield* epochSeconds
    return yield* channel.enable(connectionId, url, channelTool(connections, connectionId), now)
  }
  const cursor = yield* channel.startCursor(connectionId, channelTool(connections, connectionId))
  const revision = yield* Clock.currentTimeMillis
  const previous: Option.Option<Consumer>[] = []
  for (const event of TELEGRAM_EVENTS) {
    const current = (yield* channel.status)?.connectionId ?? connectionId
    previous.push(yield* events.activeConsumer(consumerOf(current, event)))
  }
  for (const { event, name } of named) {
    yield* events.grant(connectionId, name, {}, true)
    yield* events.subscribe({
      consumerId: consumerOf(connectionId, event),
      revision,
      connectionId,
      name,
      arguments: {},
      handlerKey: 'telegram-inbox',
    })
  }
  const status = yield* channel.enableEvents(connectionId, cursor, yield* epochSeconds)
  yield* retirePrevious(events, previous)
  yield* attempt(wake)
  return status
})

export const disableTelegram = Effect.gen(function* () {
  const channel = yield* Channel
  const events = yield* Events
  const status = yield* channel.status
  for (const event of TELEGRAM_EVENTS) {
    const binding = yield* events.activeConsumer(consumerOf(status?.connectionId, event))
    if (Option.isSome(binding)) yield* events.unsubscribe(binding.value)
  }
  if (status !== null && status.transport === 'doorbell') {
    const connections = yield* McpConnections
    // expected: the doorbell is off on this side whatever the server answers; a later ring finds no secret.
    yield* Effect.ignore(channelTool(connections, status.connectionId)('unsubscribe', {}))
  }
  yield* channel.disable
  return null
})

/**
 * A doorbell from the channel's server, checked against the secret the agent gave it, then answered at once: the pull
 * runs from the agent's `channelPull` schedule. It never renews resident authority.
 */
export const acceptDoorbell = Effect.fn('channel.acceptDoorbell')(function* (doorbell: Doorbell) {
  const channel = yield* Channel
  const secret = yield* channel.secret
  const now = yield* Clock.currentTimeMillis
  const valid = secret !== undefined && (yield* attempt(() => doorbellValid(secret, doorbell, now)))
  if (!valid) return yield* new Forbidden({ reason: 'doorbell' })
  const { schedulePull } = yield* AgentInput
  yield* attempt(schedulePull)
})
