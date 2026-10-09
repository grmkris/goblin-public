import type { InspectDetailsInput, InspectFlowsInput, InspectInput, InspectQuery } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Inspection } from '../inspect/service.ts'
import { Inspect, attempt, attemptSync } from '../services.ts'
import type { FoundationServices } from './core.ts'

/**
 * `Inspection` over the one inspector the legacy start built (layers/legacy.ts), each read wrapped the way its callers
 * wrap it today: a failure becomes its `AppError`. A native layer replaces it once the inspector is Effect-native.
 */
export const InspectionFromLegacy: Layer.Layer<Inspection, never, Inspect> = Layer.effect(
  Inspection,
  Effect.gen(function* () {
    const inspector = yield* Inspect
    return Inspection.of({
      run: Effect.fn('Inspection.run')(function* (query: InspectQuery) {
        return yield* attempt(() => inspector.run(query))
      }),
      conversations: Effect.fn('Inspection.conversations')(function* () {
        return yield* attempt(() => inspector.conversations())
      }),
      conversation: Effect.fn('Inspection.conversation')(function* (input: typeof InspectInput.conversation.Type) {
        return yield* attempt(() => inspector.conversation(input.conversation, input.before))
      }),
      turns: Effect.fn('Inspection.turns')(function* (input: typeof InspectInput.turns.Type) {
        return yield* attemptSync(() => inspector.turns(input.since, input.limit, input.conversation))
      }),
      turn: Effect.fn('Inspection.turn')(function* (operationId: string) {
        return yield* attempt(() => inspector.turn(operationId))
      }),
      problems: Effect.fn('Inspection.problems')(function* (input: typeof InspectInput.problems.Type) {
        return yield* attemptSync(() => inspector.problems(input.since, input.limit, input.all))
      }),
      flows: Effect.fn('Inspection.flows')(function* (input: InspectFlowsInput) {
        return yield* attemptSync(() => inspector.flows(input))
      }),
      details: Effect.fn('Inspection.details')(function* (input: InspectDetailsInput) {
        return yield* attempt(() => inspector.details(input))
      }),
    })
  }),
)

/** Lane O's services: telemetry, inspection and flows. It may require any foundation service. */
export const ObservabilityLive: Layer.Layer<Inspection, never, FoundationServices> = InspectionFromLegacy
