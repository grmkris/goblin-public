import * as Effect from 'effect/Effect'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** One handler per endpoint of a group, each dying when called. */
type Unused<Group extends HttpApiGroup.Constraint> = {
  readonly [Name in keyof Group['endpoints']]: () => Effect.Effect<never>
}

/**
 * A handler for every endpoint of `group` that dies when called. Spread it into `handleAll` before the handlers the
 * test serves, so a fake names only the endpoints it answers and a new endpoint needs no line in it.
 */
export const unusedHandlers = <Group extends HttpApiGroup.Constraint>(group: Group): Unused<Group> =>
  // SAFETY: the entries are made from the group's own endpoint names, one handler for each.
  Object.fromEntries(
    Object.keys(group.endpoints).map((name) => [
      name,
      () => Effect.die(new Error(`${group.identifier}.${name} is not used by this test`)),
    ]),
  ) as Unused<Group>
