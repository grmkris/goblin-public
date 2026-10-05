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
      if (origin?.memberId !== null && origin !== undefined) this.interactions.cancel(origin.memberId)
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
    const plan = await requireAccountPlan(this.#env, principal.userId)
    const { day, resetsAt } = utcDay(Math.floor(Date.now() / 1000))
    const owned = await makeWorkspaceStore(this.#env.AUTH_DB).owned(principal.userId)
    if (owned?.state === 'active') return unwrap(await this.#env.AGENTS.getByName(principal.userId).accountUsage())
    return { day, resetsAt, limit: plan.dailyTokens, used: await this.#usage.tokens(principal.userId, day) }
  }
  async invalidate(memberId: string): Promise<boolean> {
    this.interactions.cancel(memberId)
    const pi = await this.#kit.harness.pi()
    for (const row of this.#db.select().from(appConversations).all()) {
      if (this.access.origin(row.sessionId)?.memberId !== memberId) continue
      try {
        await this.access.require(row.sessionId, false)
        continue
      } catch {
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
    if (existing !== undefined) return existing.sessionId
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
    if (purpose === 'main' && principal.policy.mainHistory === 'all') await this.#history(context, principal)
    await this.access.verify(principal)
    return session
  }
  async #history(
    context: import('@earendil-works/pi-durable').Conversation,
    principal: MemberPrincipal,
  ): Promise<void> {
    const pi = await this.#kit.harness.pi()
    const root = await pi.conversation(conversationId(MAIN_THREAD), BACKGROUND)
    const entries = []
    let cursor: Parameters<NonNullable<typeof root>['entries']>[2]
    do {
      const page = await root?.entries({}, 200, cursor, BACKGROUND)
      await this.access.verify(principal)
      entries.push(...(page?.items ?? []))
      cursor = page?.next
    } while (cursor !== undefined)
    for (const entry of entries.toReversed()) {
      if (entry.model === undefined) continue
      await this.access.verify(principal)
      await context.submit(
        {
          type: 'write',
          requestId: `history:${entry.id}`,
          entry: {
            kind: 'app.member_history',
            data: { sourceEntry: entry.id, trust: 'quoted' },
            model: [
              {
                role: 'user',
                content: JSON.stringify({ trust: 'quoted', history: entry.model }),
                timestamp: Date.now(),
              },
            ],
          },
        },
        BACKGROUND,
      )
    }
  }
  async session(principal: MemberPrincipal, requested: string): Promise<string> {
    await this.access.verify(principal)
    const session = requested === MAIN_THREAD ? await this.main(principal) : requested
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
    await this.access.verify(principal)
    return views
      .filter((view) => this.access.readable(principal, view.id))
      .map((view) => {
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
    const row = this.interactions.require(id)
    const principal = await this.require(row.sessionId)
    if (principal === undefined || principal.memberVersion !== row.memberVersion)
      throw new NotFound({ what: 'interaction epoch' })
    const decisionHash = await hash(text)
    await this.require(row.sessionId)
    if (row.approvalKind === 'approval' && text !== 'deny' && text !== 'allow_once')
      throw new Conflict({ reason: 'approval decision' })
    const input =
      row.approvalKind === 'approval' && text === 'allow_once' ? await this.interactions.tool(row) : undefined
    if (input !== undefined) await this.authorizeTool(row.sessionId, input)
    const decision = this.interactions.consume(id, actor, operationId, expectedHash, decisionHash)
    if (!decision.replay && input !== undefined) {
      // Receipt is already consumed: a dispatch/crash outcome is unknown; retries never resend it.
      await this.#kit.host.manager.callTool(input.serverId, input.name, input.arguments, {
        caller: 'model',
        authorize: () => this.authorizeTool(row.sessionId, input),
      })
    }
    if (!decision.replay && row.approvalKind === 'question')
      await this.submit(principal, row.sessionId, text, `interaction:${id}:${operationId}`)
    return true
  }
}
