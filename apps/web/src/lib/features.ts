import { ApiFailure, request } from './boundary.ts'

/**
 * Runtime routes the shell uses where the server has them: moving a turn to a thread (`move`). Other work builds them,
 * so the shell asks before it offers them.
 */
export type Feature = 'move'

const known = new Map<Feature, Promise<boolean>>()

/** Whether a failure says the route is not there (yet), rather than that this request was wrong. */
export const missing = (failure: unknown): boolean =>
  failure instanceof ApiFailure && (failure.status === 404 || failure.status === 501)

/**
 * Whether the server has `feature`, asked once a page load: an empty body to its route is refused as invalid where the
 * route exists and as not found where it does not. Nothing is written, because validation comes first.
 */
export function hasFeature(feature: Feature, chat: string): Promise<boolean> {
  let answer = known.get(feature)
  if (answer === undefined) {
    answer = request(`/api/conversations/${chat}/${feature}`, { body: {} }).then(
      () => true,
      (failure: unknown) => !missing(failure),
    )
    known.set(feature, answer)
  }
  return answer
}

/** A real request found the route missing or not built yet: the shell stops offering it until the page reloads. */
export function lacks(feature: Feature): void {
  known.set(feature, Promise.resolve(false))
}
