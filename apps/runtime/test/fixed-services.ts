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
    // SAFETY: `scope` is overridden below and nothing else is called, so the database is never touched.
    super(undefined as never, undefined as never, async () => undefined)
    this.#scopes = scopes
  }

  override scope(session: string): CapabilityScope {
    return this.#scopes[session] ?? scopeOf([], true)
  }
}

import { MemberAccess } from '../src/members/access.ts'
import { MemberController } from '../src/members/controller.ts'
class OwnerAccess extends MemberAccess {
  constructor() {
    // SAFETY: only overridden origin and require are called in these owner-only unit fixtures.
    super(undefined as never, undefined as never, 'owner-fixture')
  }
  override origin(): undefined {
    return undefined
  }
  override async require(): Promise<undefined> {
    return undefined
  }
}
/** Injected owner-only context authority; native tests exercise the real D1 member authority. */
export class OwnerMembers extends MemberController {
  constructor() {
    // SAFETY: controller tests call only overridden require and OwnerAccess.origin; no storage, harness or cipher access.
    super({
      db: undefined,
      env: undefined,
      owner: 'owner-fixture',
      access: new OwnerAccess(),
      kit: { harness: undefined },
      cipher: undefined,
      usage: undefined,
    } as never)
  }
  override async require(): Promise<undefined> {
    return undefined
  }
}
