import * as Effect from 'effect/Effect'
import { type Entitlements, requirePlan } from '../billing/gates.ts'
import { Setups } from '../setup/service.ts'
import { type AppError, NotFound } from '../http/errors.ts'
import type { SkillIdentity } from '../mcp/types.ts'
import { type Resident, requireResident } from '../mcp/service.ts'

/**
 * The check a skills library runs for `session` before each dispatch to a server, bound to the caller's services (the
 * library runs it from Promise code): the plan, current resident authority, and the chat's scope: some skill of the
 * server's library for a dispatch, the one skill before the library loads or reads it (ADR 0040).
 */
export const skillScope = (
  session: string,
): Effect.Effect<
  (serverId: string, skill?: SkillIdentity) => Effect.Effect<void, AppError>,
  never,
  Entitlements | Resident | Setups
> =>
  Effect.map(
    Effect.context<Entitlements | Resident | Setups>(),
    (context) => (serverId: string, skill?: SkillIdentity) =>
      Effect.gen(function* () {
        yield* requirePlan()
        yield* requireResident
        const scope = yield* Setups.use((setups) => setups.scope(session))
        const allowed = skill === undefined ? scope.skills(serverId) : scope.skill(serverId, skill.name, skill.uri)
        if (!allowed) return yield* new NotFound({ what: 'skill scope' })
      }).pipe(Effect.provideContext(context)),
  )
