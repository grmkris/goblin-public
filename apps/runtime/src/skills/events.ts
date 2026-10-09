import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { offersEvents } from '../mcp/connection.ts'
import { Events, McpConnections } from '../mcp/service.ts'
import { Skills } from './service.ts'

/** Enabling a trusted skills library grants its exact update selectors; disable cleans up before local off. */
export const setSkillEvents = (serverId: string, enabled: boolean) =>
  Effect.gen(function* () {
    const skills = yield* Skills
    const events = yield* Events
    const snapshot = enabled ? yield* McpConnections.use((connections) => connections.connect(serverId)) : undefined
    const revision = yield* Clock.currentTimeMillis
    const modern = snapshot !== undefined && offersEvents(snapshot)
    for (const name of ['skills.updated', 'skills.list_changed']) {
      const consumerId = `skills:${serverId}:${name}`
      const old = yield* events.activeConsumer(consumerId)
      if (Option.isSome(old)) yield* events.unsubscribe(old.value)
      if (enabled && modern) {
        yield* events.grant(serverId, name, {}, true)
        yield* events.subscribe({ consumerId, revision, serverId, name, arguments: {}, handlerKey: 'skills-refresh' })
      }
    }
    yield* skills.setEnabled(serverId, enabled)
    return { serverId, enabled }
  })
