import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import { Events } from '../mcp/events.ts'
import { offersEvents } from '../mcp/connection.ts'
import { Mcp, Skills, attempt } from '../services.ts'

/** Enabling a trusted skills library grants its exact update selectors; disable cleans up before local off. */
export const setSkillEvents = (serverId: string, enabled: boolean) =>
  Effect.gen(function* () {
    const skills = yield* Skills
    const events = yield* Events
    const mcp = yield* Mcp
    const snapshot = enabled ? yield* attempt(() => mcp.manager.connect(serverId)) : undefined
    const revision = yield* Clock.currentTimeMillis
    const modern = snapshot !== undefined && offersEvents(snapshot)
    for (const name of ['skills.updated', 'skills.list_changed']) {
      const consumerId = `skills:${serverId}:${name}`
      const old = events.store.activeConsumer(consumerId)
      if (old !== undefined) yield* events.unsubscribe(old)
      if (enabled && modern) {
        events.grant(serverId, name, {}, true)
        yield* events.subscribe({ consumerId, revision, serverId, name, arguments: {}, handlerKey: 'skills-refresh' })
      }
    }
    skills.setEnabled(serverId, enabled)
    return { serverId, enabled }
  })
