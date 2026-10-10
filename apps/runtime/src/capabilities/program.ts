import type { CapabilityChange } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Chats, Conversations } from '../chats/service.ts'
import { InvalidInput } from '../http/errors.ts'
import { McpConnections, McpGrants, McpServers } from '../mcp/service.ts'
import { Skills } from '../skills/service.ts'
import { Capabilities } from './service.ts'
import { capabilityView, offers } from './view.ts'

/** A registered conversation's switches over the agent's servers, grants and skills libraries, as they are now. */
export const capabilitiesOf = (thread: string) =>
  Effect.gen(function* () {
    const kind = yield* (yield* Conversations).kindOf(thread)
    const capabilities = yield* Capabilities
    const connections = yield* McpConnections
    const servers = yield* (yield* McpServers).list()
    // What each live connection last listed; a server without one shows its granted tools as they are.
    const listings = new Map(
      yield* Effect.forEach(servers, ({ serverId }) =>
        Effect.map(connections.snapshot(serverId), (snapshot) => [serverId, Option.getOrUndefined(snapshot)] as const),
      ),
    )
    return capabilityView({
      thread,
      kind,
      servers,
      grants: yield* (yield* McpGrants).list(),
      listed: (serverId) => listings.get(serverId)?.tools,
      skillSources: yield* (yield* Skills).sources(),
      own: yield* capabilities.own(thread),
      inherited: kind === 'thread' ? yield* capabilities.inherited(thread) : [],
    })
  })

/**
 * The owner switches something on or off in a conversation, or gives a thread the switches of the one it came from.
 * Only what the conversation shows can be switched off; a subagent follows the conversations above it and main has no
 * reset. A change to subagents reaches Pi's tool filter for that conversation.
 */
export const changeCapabilities = (thread: string, change: CapabilityChange) =>
  Effect.gen(function* () {
    const view = yield* capabilitiesOf(thread)
    const capabilities = yield* Capabilities
    if (view.kind === 'subagent') return yield* new InvalidInput({ reason: 'subagent_capabilities' })
    if ('reset' in change) {
      if (yield* (yield* Chats).isConversation(thread)) return yield* new InvalidInput({ reason: 'main_reset' })
      yield* capabilities.reset(thread)
      return yield* capabilitiesOf(thread)
    }
    if (!change.on && !offers(view, change.target)) return yield* new InvalidInput({ reason: 'capability_unknown' })
    yield* capabilities.set(thread, change.target, change.on)
    if (change.target.kind === 'subagents') yield* capabilities.syncPi(thread)
    return yield* capabilitiesOf(thread)
  })
