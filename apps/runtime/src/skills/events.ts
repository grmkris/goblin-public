import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { offersEvents } from '../mcp/remote.ts'
import { Events, McpConnections } from '../mcp/service.ts'
import { Skills } from './service.ts'

/**
 * Enabling a trusted skills library grants its exact update selectors and subscribes to them where the server offers
 * them; disable cleans up before local off. A server may offer Events without the skills ones (Sidequest's are its
 * own): its subscribe is refused, the grant goes again, and its listing refreshes on its own `ttlMs` instead.
 */
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
        yield* events
          .subscribe({ consumerId, revision, serverId, name, arguments: {}, handlerKey: 'skills-refresh' })
          .pipe(
            // expected: the server does not offer this event; skills still turn on and refresh on their ttl
            Effect.catchTag('InvalidInput', () => events.grant(serverId, name, {}, false)),
          )
      }
    }
    yield* skills.setEnabled(serverId, enabled)
    return { serverId, enabled }
  })
