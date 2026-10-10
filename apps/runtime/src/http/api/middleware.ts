import { OwnerAdmission, RenewsResident, withRef } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { Entitlements } from '../../billing/gates.ts'
import { isAppError } from '../errors.ts'
import { Resident } from '../../mcp/service.ts'
import { RequestContext } from './context.ts'

/**
 * Owner admission (`OwnerAdmission` in the contract) as `ownerRequest` ran it for each owner RPC method: the account's plan,
 * then a renewal of resident authority unless the endpoint says otherwise (`RenewsResident`: changing it must not renew
 * first), then the handler. Its logs carry the endpoint, the operation and the request's reference, and every typed
 * failure it answers quotes that reference.
 */
export const OwnerAdmissionLive = Layer.effect(
  OwnerAdmission,
  Effect.gen(function* () {
    const plans = yield* Entitlements
    const resident = yield* Resident
    const admit = (renews: boolean) =>
      Effect.gen(function* () {
        yield* plans.require()
        if (renews) yield* resident.renew()
      })
    return OwnerAdmission.of((handler, { group, endpoint }) =>
      Effect.flatMap(Effect.serviceOption(RequestContext), (context) => {
        const { ref, operation } = Option.getOrUndefined(context) ?? {}
        return Effect.andThen(admit(Context.get(endpoint.annotations, RenewsResident)), handler).pipe(
          Effect.catchIf(isAppError, (error) =>
            ref === undefined ? Effect.fail(error) : Effect.flatMap(withRef(ref)(error), Effect.fail),
          ),
          Effect.annotateLogs({
            'goblin.rpc': `${group.identifier}.${endpoint.identifier}`,
            ...(operation === undefined ? {} : { 'goblin.operation': operation }),
            ...(ref === undefined ? {} : { ref }),
          }),
        )
      }),
    )
  }),
)
