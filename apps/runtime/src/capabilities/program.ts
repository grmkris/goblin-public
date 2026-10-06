import type { CapabilityChange, ConversationCapabilities } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { type AppError, InvalidInput } from '../http/errors.ts'
import {
  type AgentServices,
  Capabilities,
  Conversations,
  Mcp,
  Skills,
  attempt,
  attemptSync,
  nowSecondsEffect,
} from '../services.ts'
import { capabilityView, offers } from './view.ts'

/** A registered conversation's switches over the agent's servers, grants and skills libraries, as they are now. */
export const capabilitiesOf = (thread: string): Effect.Effect<ConversationCapabilities, AppError, AgentServices> =>
  Effect.gen(function* () {
    const kind = yield* Conversations.use((conversations) => attemptSync(() => conversations.kindOf(thread)))
    const capabilities = yield* Capabilities
    const mcp = yield* Mcp
    const skills = yield* Skills
    return capabilityView({
      thread,
      kind,
      servers: mcp.servers(),
      grants: mcp.grants(),
      listed: (serverId) => mcp.manager.snapshot(serverId)?.tools,
      skillSources: skills.sources(),
      own: capabilities.own(thread),
      inherited: kind === 'thread' ? capabilities.inherited(thread) : [],
    })
  })

/**
 * The owner switches something on or off in a conversation, or gives a thread the switches of the one it came from. Only what the
 * conversation shows can be switched off; a subagent follows the conversations above it and main has no reset. A change
 * to subagents reaches Pi's tool filter for that conversation.
 */
export const changeCapabilities = (
  thread: string,
  change: CapabilityChange,
): Effect.Effect<ConversationCapabilities, AppError, AgentServices> =>
  Effect.gen(function* () {
    const view = yield* capabilitiesOf(thread)
    const capabilities = yield* Capabilities
    const now = yield* nowSecondsEffect
    if (view.kind === 'subagent') return yield* new InvalidInput({ reason: 'subagent_capabilities' })
    if ('reset' in change) {
      if (view.kind === 'main') return yield* new InvalidInput({ reason: 'main_reset' })
      yield* attempt(() => capabilities.reset(thread, now))
      return yield* capabilitiesOf(thread)
    }
    if (!change.on && !offers(view, change.target)) return yield* new InvalidInput({ reason: 'capability_unknown' })
    capabilities.set(thread, change.target, change.on, now)
    if (change.target.kind === 'subagents') yield* attempt(() => capabilities.syncPi(thread))
    return yield* capabilitiesOf(thread)
  })
