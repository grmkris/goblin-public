import { CapabilityProfiles, type CapabilityScope, scopeOf } from '../src/capabilities/profiles.ts'
import { ResidentAuthority } from '../src/resident.ts'

/** Resident authority that is always active: the tools only ask it to `require` the current time. */
export class ActiveResident extends ResidentAuthority {
  constructor() {
    // SAFETY: `require` is overridden below and nothing else is called, so the database is never touched.
    super(undefined as never)
  }
  override require(): void {}
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
