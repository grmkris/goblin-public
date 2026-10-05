import { MAIN_THREAD, type AppContext, type QuestionSpec, type CreateConversation } from '@purrable/contracts'
import { type Extension } from '@earendil-works/pi-durable'
import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { PiHarness } from 'agents/harness/pi'
import type { MemberPrincipal, RuntimeEnv } from '../env.ts'
import type { ConversationRegistry } from '../conversations.ts'
import type { CapabilityProfiles } from '../capabilities/profiles.ts'
import type { CredentialCipher } from '../mcp/cipher.ts'
import { MemberAccess } from './access.ts'
import { MemberInteractions } from './interactions.ts'
import { MemberUsage } from './usage.ts'
import { MemberJournal } from './journal.ts'
import { hash } from './interactions.ts'
import { appConversations } from '../storage/schema.ts'
import { appSubmissionOrigins } from '../storage/routines.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import { ownerContent } from '../pi/content.ts'
import { requireAccountPlan } from '../billing/gates.ts'
import { utcDay } from '../budget.ts'
import { BudgetExhausted, Conflict, Forbidden, NotFound } from '../http/errors.ts'
import { makeWorkspaceStore } from '../workspaces/store.ts'
import { setReaders } from './readers.ts'
import type { McpHost } from '../mcp/host.ts'
import type { ResidentAuthority } from '../resident.ts'
import { unwrap } from '../http/rpc.ts'
import { answerMember } from './answers.ts'
import { limitProof } from '../workspaces/proof.ts'
import { importMemberHistory } from './history.ts'

type Kit = {
  readonly harness: PiHarness
  readonly registry: ConversationRegistry
  readonly capabilities: CapabilityProfiles
  readonly extensions: readonly Extension[]
  readonly host: McpHost
  readonly resident: ResidentAuthority
  readonly modelId: () => string
}

/** Member contexts are durable principal-bound Pi conversations, with no owner memory or automatic announcements. */
export class MemberController {
  readonly access: MemberAccess
  readonly interactions: MemberInteractions
  readonly #db: DrizzleSqliteDODatabase
  readonly #env: RuntimeEnv
  readonly #kit: Kit
  readonly #usage: MemberUsage
  readonly #journal: MemberJournal
  readonly #creating = new Map<string, Promise<string>>()
  constructor(input: {
    readonly db: DrizzleSqliteDODatabase
    readonly env: RuntimeEnv
    readonly owner: string
    readonly access: MemberAccess
    readonly kit: Kit
    readonly cipher: CredentialCipher
    readonly usage: MemberUsage
  }) {
    this.#db = input.db
    this.#env = input.env
    this.access = input.access
    this.#kit = input.kit
    this.#usage = input.usage
    this.#journal = new MemberJournal(input.db, input.kit.harness, input.usage)
    this.interactions = new MemberInteractions(input.db, input.cipher, input.owner)
  }
  async install(): Promise<void> {
    await this.#journal.install(this.access)
  }
  async require(session: string): Promise<MemberPrincipal | undefined> {
    await this.#journal.ready()
    let principal: MemberPrincipal | undefined
    try {
      principal = await this.access.require(session)
    } catch (error) {
      const origin = this.access.origin(session)
      if (origin?.memberId !== null && origin?.memberVersion !== null && origin !== undefined)
        this.interactions.cancel(origin.memberId, origin.memberVersion)
      void (await (await this.#kit.harness.pi()).conversation(conversationId(session), BACKGROUND))?.abort(BACKGROUND, {
        background: true,
      })
      throw error
    }
    if (principal === undefined) return undefined
    await this.budget(principal)
    this.#kit.registry.requireOpen(session)
    return principal
  }
  async usage(principal: MemberPrincipal) {
    await this.access.verify(principal)
    await this.#journal.ready()
    const plan = await requireAccountPlan(this.#env, principal.userId)
    const { day, resetsAt } = utcDay(Math.floor(Date.now() / 1000))
    const owned = await makeWorkspaceStore(this.#env.AUTH_DB).owned(principal.userId)
    if (owned?.state === 'active') return unwrap(await this.#env.AGENTS.getByName(principal.userId).accountUsage())
    return { day, resetsAt, limit: plan.dailyTokens, used: await this.#usage.tokens(principal.userId, day) }
  }
  async invalidate(memberId: string): Promise<boolean> {
    const pi = await this.#kit.harness.pi()
    for (const row of this.#db.select().from(appConversations).all()) {
      if (this.access.origin(row.sessionId)?.memberId !== memberId) continue
      try {
        await this.access.require(row.sessionId, false)
        continue
      } catch {
        const version = this.access.origin(row.sessionId)?.memberVersion
        if (version !== undefined && version !== null) this.interactions.cancel(memberId, version)
        await (
          await pi.conversation(conversationId(row.sessionId), BACKGROUND)
        )?.abort(BACKGROUND, { background: true })
      }
    }
    return true
  }
  async budget(principal: MemberPrincipal): Promise<void> {
    const plan = await requireAccountPlan(this.#env, principal.userId)
    const { day, resetsAt } = utcDay(Math.floor(Date.now() / 1000))
    const owned = await makeWorkspaceStore(this.#env.AUTH_DB).owned(principal.userId)
    const used =
      owned?.state === 'active'
        ? unwrap(await this.#env.AGENTS.getByName(principal.userId).accountUsage()).used
        : await this.#usage.tokens(principal.userId, day)
    if (used >= plan.dailyTokens) throw new BudgetExhausted({ limit: plan.dailyTokens, resetsAt })
  }
  async main(principal: MemberPrincipal): Promise<string> {
    const live = await this.access.verify(principal)
    const key = `${live.memberId}:${live.memberVersion}`
    const existing = this.#db
      .select()
      .from(appConversations)
      .where(
        and(
          eq(appConversations.memberId, live.memberId),
          eq(appConversations.memberVersion, live.memberVersion),
          eq(appConversations.memberPurpose, 'main'),
        ),
      )
      .get()
    if (existing !== undefined) {
      const context = await (await this.#kit.harness.pi()).conversation(conversationId(existing.sessionId), BACKGROUND)
      if (context !== undefined) await importMemberHistory(this.#db, this.#kit.harness, context, live, this.access)
      return existing.sessionId
    }
    const pending = this.#creating.get(key)
    if (pending !== undefined) return pending
    const creating = this.create(live, 'main')
    this.#creating.set(key, creating)
    try {
      return await creating
    } finally {
      this.#creating.delete(key)
    }
  }
  async create(
    principal: MemberPrincipal,
    purpose: 'main' | 'private',
    from?: CreateConversation['from'],
  ): Promise<string> {
    await this.access.verify(principal)
    const pi = await this.#kit.harness.pi()
    const parent = from === undefined ? undefined : await this.session(principal, from.conversation)
    const source = parent === undefined ? undefined : await pi.conversation(conversationId(parent), BACKGROUND)
    const at =
      from === undefined
        ? undefined
        : (
            await source?.entries(
              { minEntryId: entryId(from.entry), maxEntryId: entryId(from.entry) },
              1,
              undefined,
              BACKGROUND,
            )
          )?.items[0]
    if (from !== undefined && at === undefined) throw new NotFound({ what: 'fork entry' })
    const agent = { extensions: this.#kit.extensions, instructions: null, tools: null }
    const context =
      source !== undefined && at !== undefined
        ? await source.fork(at.id, { ownership: { kind: 'ownerless' }, agent }, BACKGROUND)
        : await pi.createConversation({ ownership: { kind: 'ownerless' }, agent }, BACKGROUND)
    await this.access.verify(principal)

    const session = String(context.id)
    this.#kit.registry.registerMember({
      session,
      principal,
      title: purpose === 'main' ? `Main · member ${principal.memberId}` : 'Private conversation',
      visibility: 'member',
      now: Math.floor(Date.now() / 1000),
      purpose,
      ...(parent === undefined ? {} : { parent }),
      ...(at === undefined ? {} : { forkEntry: at.id }),
    })
    if (parent !== undefined) this.#kit.capabilities.copy(parent, session, Math.floor(Date.now() / 1000))
    await context.configure(
      { model: { provider: `purrable-member:${session}`, modelId: this.#kit.modelId() } },
      BACKGROUND,
    )
    if (purpose === 'main') await importMemberHistory(this.#db, this.#kit.harness, context, principal, this.access)
    await this.access.verify(principal)
    return session
  }
  async session(principal: MemberPrincipal, requested: string): Promise<string> {
    await this.access.verify(principal)
    const session = requested === MAIN_THREAD ? await this.main(principal) : requested
    // A named reader cannot revive an origin fenced by removal or a policy/history downgrade.
    await this.access.require(session, false)
    if (!this.access.readable(principal, session)) throw new NotFound({ what: 'conversation' })
    return this.#kit.registry.require(session)
  }
  async submit(
    principal: MemberPrincipal,
    requested: string,
    text: string,
    operationId: string,
    appContext: readonly AppContext[] = [],
  ) {
    await this.access.verify(principal, true)
    const session = await this.session(principal, requested)
    await this.require(session)
    const origin = this.access.origin(session)
    if (origin?.principalUserId !== principal.userId) throw new Forbidden({ reason: 'conversation requester' })
    const requestHash = await hash(
      JSON.stringify({
        text,
        appContext,
        user: principal.userId,
        member: principal.memberId,
        version: principal.memberVersion,
      }),
    )
    await this.access.verify(principal, true)
    const previous = this.#db
      .select()
      .from(appSubmissionOrigins)
      .where(and(eq(appSubmissionOrigins.sessionId, session), eq(appSubmissionOrigins.operationId, operationId)))
      .get()
    if (
      previous !== undefined &&
      (previous.principalUserId !== principal.userId || previous.requestHash !== requestHash)
    )
      throw new Conflict({ reason: 'submission requester' })
    this.#db
      .insert(appSubmissionOrigins)
      .values({
        sessionId: session,
        operationId,
        principalUserId: principal.userId,
        role: principal.role,
        source: 'web',
        memberId: principal.memberId,
        memberVersion: principal.memberVersion,
        scopeHash: await hash(JSON.stringify(principal.policy)),
        requestHash,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run()
    if (origin.memberPurpose === 'main') await this.#project(session, `input:${operationId}`, principal.userId, text)
    await this.require(session)
    const receipt = await this.#kit.harness.submit(ownerContent(text, appContext), { session, operationId })
    return receipt
  }
  async #project(session: string, operationId: string, userId: string, text: string): Promise<void> {
    this.#journal.capture({
      key: `member:${session}:${operationId}`,
      session,
      user: userId,
      kind: 'exchange',
      body: text,
      at: Date.now(),
    })
    await this.#journal.ready()
  }

  async list(principal: MemberPrincipal) {
    await this.access.verify(principal)
    const main = await this.main(principal)
    const views = await this.#kit.registry.list()
    const readable = []
    for (const view of views) {
      try {
        await this.access.require(view.id, false)
        if (this.access.readable(principal, view.id)) readable.push(view)
      } catch {
        continue
      }
    }
    await this.access.verify(principal)
    return readable.map((view) => {
      const { parent, ...base } = view
      const rest = {
        ...base,
        canCompose: principal.role === 'member' && this.access.origin(view.id)?.principalUserId === principal.userId,
      }
      return view.id === main
        ? { ...rest, id: MAIN_THREAD, kind: 'main' as const, title: 'Main' }
        : {
            ...rest,
            ...(parent !== undefined && this.access.readable(principal, parent)
              ? { parent: parent === main ? MAIN_THREAD : parent }
              : {}),
          }
    })
  }
  async listInteractions(principal: MemberPrincipal) {
    const rows = await this.interactions.list(principal.userId)
    const allowed = []
    for (const row of rows) {
      try {
        await this.access.require(row.session, false)
        allowed.push(row)
      } catch {
        continue
      }
    }
    await this.access.verify(principal)
    return allowed
  }
  async question(session: string, callId: string, questions: readonly QuestionSpec[], answerer: 'requester' | 'owner') {
    const principal = await this.require(session)
    if (principal === undefined) return undefined
    return this.interactions.create({ session, callId, principal, kind: 'question', intent: { questions }, answerer })
  }
  async approval(session: string, callId: string, tool: unknown) {
    const principal = await this.require(session)
    if (principal === undefined) return undefined
    return this.interactions.create({
      session,
      callId,
      principal,
      kind: 'approval',
      intent: { tool },
      answerer: 'owner',
    })
  }
  async requestAccess(principal: MemberPrincipal, operationId: string, message: string) {
    await this.access.verify(principal)
    const session = await this.main(principal)
    await limitProof(this.#env.AUTH_DB, `access-request:${principal.memberId}`, 10, 3_600_000)
    await this.access.verify(principal)
    return this.interactions.create({
      session,
      callId: `access:${operationId}`,
      principal,
      kind: 'access',
      intent: { message },
      answerer: 'owner',
    })
  }
  async authorizeTool(session: string, input: { serverId: string; name: string }): Promise<void> {
    await this.require(session)
    this.#kit.resident.require(Math.floor(Date.now() / 1000))
    if (!this.#kit.capabilities.scope(session).tool(input.serverId, input.name))
      throw new Conflict({ reason: 'revise member policy or conversation exclusions before approval' })
    if (
      !this.#kit.host
        .grants()
        .some((g) => g.serverId === input.serverId && g.capability === 'tool' && g.name === input.name)
    )
      throw new Conflict({ reason: 'owner Connections consent required' })
  }
  async readers(principal: MemberPrincipal, requested: string, readers: readonly string[]): Promise<boolean> {
    const session = await this.session(principal, requested)
    await this.access.verify(principal, true)
    if (this.access.origin(session)?.principalUserId !== principal.userId)
      throw new NotFound({ what: 'conversation creator' })
    await setReaders(this.#db, this.#env, principal, session, readers)
    await this.access.verify(principal, true)
    return true
  }
  writable(principal: MemberPrincipal, session: string): void {
    if (this.access.origin(session)?.principalUserId !== principal.userId)
      throw new NotFound({ what: 'conversation creator' })
  }
  async answer(actor: string, id: string, operationId: string, expectedHash: string, text: string): Promise<boolean> {
    return answerMember(this, this.#kit.host, this.#journal, { actor, id, operationId, expectedHash, text })
  }
}
