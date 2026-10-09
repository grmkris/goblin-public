import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { CapabilityProfiles, type CapabilityScope, scopeOf } from '../src/capabilities/profiles.ts'
import { Resident } from '../src/mcp/service.ts'

/** A resident authority method no fake caller reaches. */
const unused = () => Effect.die('resident authority: not used here')

/**
 * Resident authority as the owner gate and the programs use it (`Resident`), always current: `renewals` holds the time
 * (epoch seconds) of each renewal the gate asked for. Nothing that stands it in asks for its status or changes it.
 */
export const currentResident = () => {
  const renewals: number[] = []
  const service = Resident.of({
    status: unused,
    renew: () =>
      Effect.map(Clock.currentTimeMillis, (millis) => {
        renewals.push(Math.floor(millis / 1000))
      }),
    revoke: unused,
    enable: unused,
    require: () => Effect.void,
  })
  return { service, renewals }
}

/** Fixed switches per conversation (everything on for any other): the tools only ask for a `scope`. */
export class FixedProfiles extends CapabilityProfiles {
  readonly #scopes: Readonly<Record<string, CapabilityScope>>

  constructor(scopes: Readonly<Record<string, CapabilityScope>>) {
    // SAFETY: `scope` is overridden below and nothing else is called, so the database and directory are never touched.
    super(undefined as never, undefined as never, async () => undefined, undefined as never)
    this.#scopes = scopes
  }

  override scope(session: string): CapabilityScope {
    return this.#scopes[session] ?? scopeOf([], true)
  }
}
