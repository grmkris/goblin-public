import * as Effect from 'effect/Effect'
import { type Entitlements, requirePlan } from '../billing/gates.ts'
import { Capabilities } from '../capabilities/service.ts'
import { type AppError, NotFound } from '../http/errors.ts'
import { type Resident, requireResident } from '../mcp/service.ts'

/**
 * The check a skills library runs for `session` before each dispatch to a server, bound to the caller's services (the
 * library runs it from Promise code): the plan, current resident authority, and the conversation's skills switch.
 */
export const skillScope = (
  session: string,
): Effect.Effect<(serverId: string) => Effect.Effect<void, AppError>, never, Entitlements | Resident | Capabilities> =>
  Effect.map(
    Effect.context<Entitlements | Resident | Capabilities>(),
    (context) => (serverId: string) =>
      Effect.gen(function* () {
        yield* requirePlan()
        yield* requireResident
        const scope = yield* Capabilities.use((capabilities) => capabilities.scope(session))
        if (!scope.skills(serverId)) return yield* new NotFound({ what: 'skill scope' })
      }).pipe(Effect.provideContext(context)),
  )
