import { OwnerAdmission, RenewsResident, withRef } from '@goblin/contracts/api'
import { FORWARDED_HEADER, InternalGate, RequiresPlan } from '@goblin/contracts/internal'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import type * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { Entitlements } from '../../billing/gates.ts'
import { NotFound, isAppError } from '../errors.ts'
import { Resident } from '../../mcp/service.ts'
import { RequestContext } from './context.ts'

/**
 * `handler` behind `admit`, as every API of the agent runs it: its logs carry the endpoint, the operation and the
 * request's reference, and every typed failure it answers quotes that reference.
 */
const admitted = <A, E, R, E1, R1>(
  handler: Effect.Effect<A, E, R>,
  admit: Effect.Effect<void, E1, R1>,
  names: { readonly group: HttpApiGroup.Top; readonly endpoint: HttpApiEndpoint.Top },
) =>
  Effect.flatMap(Effect.serviceOption(RequestContext), (context) => {
    const { ref, operation } = Option.getOrUndefined(context) ?? {}
    return Effect.andThen(admit, handler).pipe(
      Effect.catchIf(isAppError, (error) =>
        ref === undefined ? Effect.fail(error) : Effect.flatMap(withRef(ref)(error), Effect.fail),
      ),
      Effect.annotateLogs({
        'goblin.rpc': `${names.group.identifier}.${names.endpoint.identifier}`,
        ...(operation === undefined ? {} : { 'goblin.operation': operation }),
        ...(ref === undefined ? {} : { ref }),
      }),
    )
  })

/**
 * Owner admission (`OwnerAdmission` in the contract): the account's plan, then a renewal of resident authority unless
 * the endpoint says otherwise (`RenewsResident`: changing it must not renew first), then the handler.
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
    return OwnerAdmission.of((handler, names) =>
      admitted(handler, admit(Context.get(names.endpoint.annotations, RenewsResident)), names),
    )
  }),
)

/**
 * The internal gate (`InternalGate` in the contract): a request the Worker's edge forwarded for the owner is no
 * internal request, whatever its path became on the way, so it names no route (404). Then the account's plan, as the
 * agent keeps it, unless the endpoint needs none (`RequiresPlan`). Resident authority is never renewed here.
 */
export const InternalGateLive = Layer.effect(
  InternalGate,
  Effect.gen(function* () {
    const plans = yield* Entitlements
    const admit = (plan: boolean) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers[FORWARDED_HEADER] !== undefined) return yield* new NotFound({ what: 'route' })
        if (plan) yield* plans.require()
      })
    return InternalGate.of((handler, names) =>
      admitted(handler, admit(Context.get(names.endpoint.annotations, RequiresPlan)), names),
    )
  }),
)
