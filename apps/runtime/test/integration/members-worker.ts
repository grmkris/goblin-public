/** Native D1/Agent fixture. These test levers never enter the deployed Worker. */
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import runtime from '../../src/worker.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { readJson } from '../../src/http/body.ts'
import { failureResponse } from '../../src/http/respond.ts'
import { makeBillingStore } from '../../src/billing/store.ts'
import { liveApi } from '../../src/billing/dodo.ts'
import { billingTestRoute } from '../../src/billing/test-route.ts'
import { PersonalAgent } from '../../src/agent.ts'
import { scriptedStreams } from './model.ts'
import { accountAdmissions, members } from '../../src/workspaces/schema.ts'
import { makeWorkspaceStore } from '../../src/workspaces/store.ts'
import { deleteAccountWorkspaces } from '../../src/workspaces/lifecycle.ts'

export class MembersAgent extends PersonalAgent {
  protected override modelStreams() {
    return scriptedStreams(() => undefined)
  }
}
const Command = Schema.Struct({
  userId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(['member', 'viewer'])),
})
async function lever(request: Request, env: RuntimeEnv): Promise<Response> {
  const body = await readJson(request, Command)
  const action = new URL(request.url).pathname.split('/').at(-1)
  const db = drizzle(env.AUTH_DB)
  if (action === 'invitation-account') {
    await db
      .update(accountAdmissions)
      .set({ kind: 'invitation' })
      .where(eq(accountAdmissions.userId, body.userId))
      .run()
    return Response.json({ ok: true })
  }
  if (action === 'member' && body.workspaceId !== undefined) {
    await db
      .insert(members)
      .values({
        id: crypto.randomUUID(),
        workspaceId: body.workspaceId,
        userId: body.userId,
        role: body.role ?? 'member',
        state: 'active',
        policyJson: '{"servers":[],"skills":[],"mainHistory":"own"}',
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
export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    const url = new URL(request.url)
    const input = new Request(new URL(url.pathname + url.search, env.APP_URL), request)
    try {
      if (url.pathname.startsWith('/__test/members/')) return await lever(input, env)
      if (url.pathname.startsWith('/__test/billing/'))
        return await Effect.runPromise(
          billingTestRoute(input, env, {
            store: makeBillingStore(env.AUTH_DB),
            dodo: liveApi('test_mode', 'unused', 'unused'),
            productId: 'unused',
          }),
        )
      return await runtime.fetch(input, env, ctx)
    } catch (cause) {
      return failureResponse(cause, url.pathname, 'members-fixture')
    }
  },
}
