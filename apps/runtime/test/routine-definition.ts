import { type RoutineDefinition, type RoutineHandOver, handOverOf } from '@goblin/contracts'

/** `definition` with its hand-over changed by `patch`, for the fixtures, which hand their work to Goblin. */
export const withHandOver = (
  definition: RoutineDefinition,
  patch: (handOver: RoutineHandOver) => Partial<Omit<RoutineHandOver, 'kind'>>,
): RoutineDefinition => {
  const handOver = handOverOf(definition)
  if (handOver === undefined) throw new Error('the fixture hands nothing over')
  return { ...definition, handTo: { ...handOver, ...patch(handOver) } }
}
