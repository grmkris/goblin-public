import { MemberPolicy } from '@purrable/contracts'
import type { MemberPrincipal, RuntimeEnv } from '../env.ts'
import * as Schema from 'effect/Schema'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appConversations, appMcpEndpoints, appTelegramChannel, appChannel } from '../storage/schema.ts'
import { makeWorkspaceStore } from '../workspaces/store.ts'
import { Forbidden, NotFound } from '../http/errors.ts'
import { isReader } from './readers.ts'
import type { MemberBound } from '../capabilities/member.ts'

/** Immutable context provenance, with live D1 hydration for the synchronous shared scope gate. */
export class MemberAccess {
  readonly #db: DrizzleSqliteDODatabase
  readonly #env: RuntimeEnv
  readonly #owner: string
  readonly #live = new Map<string, MemberPrincipal>()
  constructor(db: DrizzleSqliteDODatabase, env: RuntimeEnv, owner: string) {
    this.#db = db
    this.#env = env
    this.#owner = owner
  }
  /** Walk all parents, including forks, so descendants never shed a member ceiling. Cycles fail closed. */
  origin(session: string) {
    const seen = new Set<string>()
    let at: string | null = session
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const row = this.#db.select().from(appConversations).where(eq(appConversations.sessionId, at)).get()
      if (row === undefined) throw new NotFound({ what: 'conversation' })
      if (row.memberId !== null) return row
      at = row.parentSession
    }
    if (at !== null) throw new NotFound({ what: 'conversation' })
    return undefined
  }
  bound(session: string): MemberBound | null | undefined {
    const origin = this.origin(session)
    if (origin === undefined) return null
    const principal = this.#live.get(origin.memberId ?? '')
    if (principal === undefined || principal.memberVersion !== origin.memberVersion) return undefined
    return {
      policy: principal.policy,
      role: principal.role === 'member' ? 'member' : 'viewer',
      endpoint: (id) => this.#db.select().from(appMcpEndpoints).where(eq(appMcpEndpoints.serverId, id)).get()?.endpoint,
      telegramServer: (this.#db.select().from(appTelegramChannel).get() ?? this.#db.select().from(appChannel).get())
        ?.serverId,
    }
  }
  principal(session: string): MemberPrincipal | undefined {
    const origin = this.origin(session)
    return origin?.memberId === null || origin === undefined ? undefined : this.#live.get(origin.memberId)
  }

  /** The supplied principal came from the Worker; read the authoritative version again after every wait. */
  async verify(principal: MemberPrincipal, execute = false): Promise<MemberPrincipal> {
    const store = makeWorkspaceStore(this.#env.AUTH_DB)
    if (principal.sessionId !== undefined) {
      const selection = await store.selection(principal.sessionId)
      if (selection?.workspaceId !== principal.workspaceId || selection.context !== principal.context)
        throw new NotFound({ what: 'workspace selection' })
    }
    const row = (await store.list(principal.userId)).find(
      (item) => item.workspace.id === principal.workspaceId && item.member.id === principal.memberId,
    )
    if (
      row === undefined ||
      row.workspace.ownerUserId !== this.#owner ||
      principal.ownerUserId !== this.#owner ||
      row.member.version !== principal.memberVersion ||
      row.member.role !== principal.role
    ) {
      this.#live.delete(principal.memberId)
      throw new NotFound({ what: 'membership' })
    }
    if (execute && row.member.role !== 'member') throw new Forbidden({ reason: 'viewer execution' })
    const live = { ...principal, policy: Schema.decodeUnknownSync(MemberPolicy)(JSON.parse(row.member.policyJson)) }
    this.#live.set(live.memberId, live)
    return live
  }
  async require(session: string, execute = true): Promise<MemberPrincipal | undefined> {
    const origin = this.origin(session)
    if (origin === undefined) return undefined
    if (origin.principalUserId === null || origin.memberId === null || origin.memberVersion === null)
      throw new NotFound({ what: 'member context' })
    const rows = await makeWorkspaceStore(this.#env.AUTH_DB).list(origin.principalUserId)
    const row = rows.find((item) => item.member.id === origin.memberId && item.workspace.ownerUserId === this.#owner)
    if (row === undefined || row.member.version !== origin.memberVersion) {
      this.#live.delete(origin.memberId)
      throw new NotFound({ what: 'member context epoch' })
    }
    return this.verify(
      {
        userId: row.member.userId,
        workspaceId: row.workspace.id,
        ownerUserId: this.#owner,
        memberId: row.member.id,
        memberVersion: row.member.version,
        role: row.member.role,
        policy: Schema.decodeUnknownSync(MemberPolicy)(JSON.parse(row.member.policyJson)),
        context: null,
      },
      execute,
    )
  }
  /** Owner administrative reads cover everything. A member reads only live permitted contexts. */
  readable(principal: MemberPrincipal, session: string): boolean {
    if (principal.role === 'owner' && principal.userId === this.#owner) return true
    const origin = this.origin(session)
    return (
      origin !== undefined &&
      ((origin.principalUserId === principal.userId && origin.memberVersion === principal.memberVersion) ||
        isReader(this.#db, session, principal.userId))
    )
  }
}
