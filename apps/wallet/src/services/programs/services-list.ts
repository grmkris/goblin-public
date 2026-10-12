import { DEFAULT_SERVICES, type ServiceRule } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Ledger } from '../ledger.ts'

/** The paid services the owner allows: the built-in defaults, minus any the owner switched off. */
export const allowedServices = (overrides: Readonly<Record<string, boolean>>): ServiceRule[] =>
  DEFAULT_SERVICES.filter((service) => overrides[service.id] !== false)

export const listServices = Effect.gen(function* () {
  const overrides = yield* (yield* Ledger).use((api) => api.serviceOverrides())
  return allowedServices(overrides)
})
