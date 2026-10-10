import type * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

/**
 * A test's services, built once from `layer` and kept until `dispose` ends them (and closes what they hold): `run`
 * runs a program on them and rejects with its typed failure.
 */
export const servicesOf = <R, E>(layer: Layer.Layer<R, E>) => {
  const runtime = ManagedRuntime.make(layer)
  return {
    run: <A, E2>(program: Effect.Effect<A, E2, R>): Promise<A> => runtime.runPromise(program),
    dispose: (): Promise<void> => runtime.dispose(),
  }
}
