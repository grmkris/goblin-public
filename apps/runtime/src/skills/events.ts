import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { offersEvents } from '../mcp/remote.ts'
import { Events, McpConnections } from '../mcp/service.ts'
import { Skills } from './service.ts'

/**
 * Enabling a trusted skills library grants its exact update selectors and subscribes to them where the server offers
 * them; disable cleans up before local off. A server may offer Events without the skills ones (Sidequest's are its
 * own), or refuse its Events to this connection (Sidequest's setup-only one): the grant goes again, and its listing
 * refreshes on its own `ttlMs` instead. A connection that fails otherwise (transport, sign-in) fails the switch.
 */
export const setSkillEvents = (connectionId: string, enabled: boolean) =>
  Effect.gen(function* () {
    const skills = yield* Skills
    const events = yield* Events
    const snapshot = enabled ? yield* McpConnections.use((connections) => connections.connect(connectionId)) : undefined
    const revision = yield* Clock.currentTimeMillis
    const modern = snapshot !== undefined && offersEvents(snapshot)
    for (const name of ['skills.updated', 'skills.list_changed']) {
      const consumerId = `skills:${connectionId}:${name}`
      const old = yield* events.activeConsumer(consumerId)
      if (Option.isSome(old)) yield* events.unsubscribe(old.value)
      if (enabled && modern) {
        yield* events.grant(connectionId, name, {}, true)
        const withdraw = events.grant(connectionId, name, {}, false)
        yield* events
          .subscribe({ consumerId, revision, connectionId, name, arguments: {}, handlerKey: 'skills-refresh' })
          .pipe(
            // expected: the server does not offer this event, or refuses it to this connection; skills still turn on
            // and refresh on their ttl
            Effect.catchTag('InvalidInput', () => withdraw),
            Effect.catchTag('UpstreamMcp', (error) => (error.reason === 'remote-rpc' ? withdraw : Effect.fail(error))),
          )
      }
    }
    yield* skills.setEnabled(connectionId, enabled)
    return { connectionId, enabled }
  })
