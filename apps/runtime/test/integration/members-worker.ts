/** Native D1/Agent fixture. These test levers never enter the deployed Worker. */
import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import runtime from '../../src/worker.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { readJson } from '../../src/http/body.ts'
import { failureResponse } from '../../src/http/respond.ts'
import { makeBillingStore } from '../../src/billing/store.ts'
import { liveApi } from '../../src/billing/dodo.ts'
import { billingTestRoute } from '../../src/billing/test-route.ts'
import { PersonalAgent } from '../../src/agent.ts'
import { scriptedStreams, type SeenRequest } from './model.ts'
import { accountAdmissions, admissions, invitations, members } from '../../src/workspaces/schema.ts'
import type { MailMessage } from '../../src/auth/mail.ts'
import { makeWorkspaceStore } from '../../src/workspaces/store.ts'
import { deleteAccountWorkspaces } from '../../src/workspaces/lifecycle.ts'
import { maintenanceCase, observeWorkspace } from './members-maintenance.ts'
import { MemberPolicy } from '@purrable/contracts'
import { MembersMcpFixture } from './members-mcp.ts'

export class MembersAgent extends PersonalAgent {
  readonly #mcp = new MembersMcpFixture()
  readonly #requests: SeenRequest[] = []
  protected override modelStreams() {
    return scriptedStreams((request) => this.#requests.push(request))
  }
  protected override mcpFetch(): typeof fetch {
    return this.#mcp.fetch
  }
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/mcp-stats') return Response.json(this.#mcp.calls)
    if (new URL(request.url).pathname === '/__test/model-stats') return Response.json(this.#requests)
    return super.onRequest(request)
  }
}
const Command = Schema.Struct({
  userId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(['member', 'viewer'])),
  email: Schema.optional(Schema.String),
  invitationId: Schema.optional(Schema.String),
  policy: Schema.optional(MemberPolicy),
  memberId: Schema.optional(Schema.String),
})
const fixtureMail = new Map<string, MailMessage>()
async function deleteFixture(action: string | undefined, body: typeof Command.Type, env: RuntimeEnv) {
  if (action === 'delete-fault') {
    // Inject only the destruction failure; revocation and checkpoints use actual workerd D1.
    const agents = {
      getByName: () => {
        throw new Error('fixture destruction failed')
      },
    }
    await deleteAccountWorkspaces({ AGENTS: agents }, env.AUTH_DB, body.userId)
  }
  if (action === 'delete') await deleteAccountWorkspaces(env, env.AUTH_DB, body.userId)
  return Response.json((await makeWorkspaceStore(env.AUTH_DB).owned(body.userId)) ?? null)
}
async function lever(request: Request, env: RuntimeEnv): Promise<Response> {
  const body = await readJson(request, Command)
  const action = new URL(request.url).pathname.split('/').at(-1)
  const email = body.email ?? ''
  const db = drizzle(env.AUTH_DB)
  if (action === 'mcp-stats') return env.AGENTS.getByName(body.userId).fetch('https://agent/__test/mcp-stats')
  if (action === 'model-stats') return env.AGENTS.getByName(body.userId).fetch('https://agent/__test/model-stats')
  if (action === 'invalidate' && body.memberId !== undefined)
    return Response.json(await env.AGENTS.getByName(body.userId).memberInvalidate(body.memberId))
  if (action === 'mail') return Response.json(fixtureMail.get(email) ?? null)
  if (action === 'expire' && body.invitationId !== undefined) {
    await db.update(invitations).set({ expiresAt: 1 }).where(eq(invitations.id, body.invitationId)).run()
    return Response.json({ ok: true })
  }
  if (action === 'expire-admission') {
    await db.update(admissions).set({ expiresAt: 1 }).where(eq(admissions.email, email)).run()
    return Response.json({ ok: true })
  }
  if (action === 'invitation-account') {
    await db
      .update(accountAdmissions)
      .set({ kind: 'invitation' })
      .where(eq(accountAdmissions.userId, body.userId))
      .run()
    return Response.json({ ok: true })
  }
  if (action === 'member' || action === 'revoke' || action === 'policy') return mutateMember(action, body, db)
  return deleteFixture(action, body, env)
}
async function mutateMember(
  action: string,
  body: typeof Command.Type,
  db: ReturnType<typeof drizzle>,
): Promise<Response> {
  if (action === 'member' && body.workspaceId !== undefined) {
    await db
      .insert(members)
      .values({
        id: crypto.randomUUID(),
        workspaceId: body.workspaceId,
        userId: body.userId,
        role: body.role ?? 'member',
        state: 'active',
        policyJson: JSON.stringify(body.policy ?? { servers: [], skills: [], mainHistory: 'own' }),
        version: 1,
        joinedAt: Date.now(),
      })
      .run()
    return Response.json({ ok: true })
  }
  if (action === 'revoke') {
    await db.update(members).set({ state: 'removed', version: 2 }).where(eq(members.userId, body.userId)).run()
    return Response.json({ ok: true })
  }
  if (action === 'policy' && body.policy !== undefined) {
    await db
      .update(members)
      .set({ policyJson: JSON.stringify(body.policy), version: sql`${members.version} + 1` })
      .where(eq(members.userId, body.userId))
      .run()
    return Response.json({ ok: true })
  }
  return Response.json({ ok: false })
}
export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    const url = new URL(request.url)
    const input = new Request(new URL(url.pathname + url.search, env.APP_URL), request)
    try {
      if (url.pathname === '/__test/members/queries') return await observeWorkspace(input, env)
      if (url.pathname === '/__test/members/maintenance') return await maintenanceCase(input, env)
      if (url.pathname.startsWith('/__test/members/')) return await lever(input, env)
      if (url.pathname.startsWith('/__test/billing/'))
        return await Effect.runPromise(
          billingTestRoute(input, env, {
            store: makeBillingStore(env.AUTH_DB),
            dodo: liveApi('test_mode', 'unused', 'unused'),
            productId: 'unused',
          }),
        )
      const mail = {
        send: async (message: MailMessage) => {
          fixtureMail.set(message.to, message)
        },
      }
      const withMail = request.headers.get('x-fixture-mail') === '1'
      const executionEnv = (() => {
        if (request.headers.get('x-fixture-members-closed') !== '1') return env
        const { MEMBER_EXECUTION_ENABLED: _memberExecutionEnabled, ...closedEnv } = env
        return closedEnv
      })()
      return await runtime.fetch(
        input,
        withMail
          ? { ...executionEnv, SIGNUP_MODE: 'closed', MAIL: mail, MAIL_SENDER: 'hello@purrable.lol' }
          : executionEnv,
        ctx,
      )
    } catch (cause) {
      return failureResponse(cause, url.pathname, 'members-fixture')
    }
  },
}
