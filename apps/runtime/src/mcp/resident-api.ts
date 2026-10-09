import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Events, Resident } from './service.ts'

/**
 * The `resident` group (ADR 0003): resident authority's status, and revoking or re-enabling it. A revocation cleans up
 * the Events subscriptions first, while the authorization that made them still holds. The gate does not renew
 * authority before `set` (`RenewsResident`), as the Durable Object's `residentSet` never did.
 */
export const ResidentHandlers = HttpApiBuilder.group(OwnerApi, 'resident', (handlers) =>
  handlers
    .handle('status', () => Resident.use((resident) => resident.status()))
    .handle('set', ({ payload }) =>
      Effect.gen(function* () {
        const resident = yield* Resident
        if (payload.enabled) return yield* resident.enable()
        yield* (yield* Events).disableServer()
        return yield* resident.revoke()
      }),
    ),
)
