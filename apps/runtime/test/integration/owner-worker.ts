import { authFixtureRoute, fixtureAuth } from './auth-fixture.ts'
/** Native auth D1 + owner Agent fixture; test levers never enter the deployed Worker. */
import { Effect, Schema } from 'effect'
import runtime from '../../src/worker.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { failureResponse } from '../../src/http/respond.ts'
import { makeBillingStore } from '../../src/billing/store.ts'
import { liveApi } from '../../src/billing/dodo.ts'
import { billingTestRoute } from '../../src/billing/test-route.ts'
import { PersonalAgent } from '../../src/agent.ts'
import { queueModel } from './queue-model.ts'
import { approvalsProbe } from './approvals-probe.ts'
import { requireUserSession } from '../../src/auth/index.ts'
import { AppsMcpFixture } from './apps-mcp.ts'
import { permutePrimary, profileEnabled } from './primary-profile.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { unwrap } from '../../src/http/rpc.ts'
import type { MovePhase } from '../../src/chats/mover.ts'
import { moveState, readRounds } from './move-probe.ts'

export class OwnerAgent extends PersonalAgent {
  readonly #mcp = new AppsMcpFixture()
  /** The move boundary at which the next move stops the object (a restart then finishes the move). */
  #crashAt: MovePhase | undefined
  /** The move boundary at which the next move waits for `/test/move/resume`, and the phase it waits at. */
  #pauseAt: MovePhase | undefined
  #paused: { readonly phase: MovePhase; readonly resume: () => void } | undefined
  protected override async moveBoundary(phase: MovePhase): Promise<void> {
    if (this.#pauseAt === phase) {
      this.#pauseAt = undefined
      const gate = Promise.withResolvers<void>()
      this.#paused = { phase, resume: gate.resolve }
      await gate.promise
      this.#paused = undefined
    }
    if (this.#crashAt !== phase) return
    this.#crashAt = undefined
    this.ctx.abort(`move restart after ${phase}`)
    // Hold the mover here until the reset lands: nothing past this boundary runs in the aborted instance, so the
    // restart always interrupts the move at `phase`.
    await new Promise<never>(() => undefined)
  }
  override async onStart(): Promise<void> {
    await super.onStart()
    if (profileEnabled(this.env)) await permutePrimary(this.ctx.storage, this.harness)
  }
  protected override modelStreams() {
    return queueModel(this).streams
  }
  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/test/primary-profile' && profileEnabled(this.env)) {
      const operationId = 'permuted-owner-proof'
      await this.submit('1', 'prove the owner primary binding', operationId)
      const session = new ChatDirectory(drizzle(this.ctx.storage)).session('1')
      const result = await this.harness.wait(operationId, { session })
      const messages = await this.harness.messages({ session: result.session })
      return Response.json({
        ...result,
        messages: messages.length,
        rootMessages: (await this.harness.messages({ session: '1' })).length,
      })
    }
    if (path === '/test/topics/sessions')
      return Response.json({ sessions: (await this.harness.sessions.list()).length })
    if (path === '/test/topics/inbound') {
      const { input, operationId } = Schema.decodeUnknownSync(
        Schema.Struct({ input: Schema.String, operationId: Schema.String }),
      )(await request.json())
      return Response.json(unwrap(await this.askAsClient('topics-client', input, operationId, 5000)))
    }
    if (path.startsWith('/test/move/')) return this.#moveProbe(path, request)
    if (path === '/test/queue/held') return Response.json({ inputs: queueModel(this).held() })
    if (path === '/test/queue/seen') return Response.json({ requests: queueModel(this).requests() })
    if (path === '/test/retrieval/excerpts')
      return Response.json(
        this.ctx.storage.sql
          .exec(
            'SELECT entry_id AS entry, session_id AS session, chat_id AS chat, text FROM app_transcript_excerpts ORDER BY entry_id',
          )
          .toArray(),
      )
    if (path === '/test/queue/release') {
      const { input } = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.String }))(await request.json())
      return Response.json({ released: queueModel(this).release(input) })
    }
    if (path === '/test/approvals/calls') return Response.json(this.#mcp.calls)
    if (path === '/test/approvals/recovery')
      return Response.json(await approvalsProbe(this.ctx.storage, this.env.CREDENTIAL_KEY))
    return super.onRequest(request)
  }
  /** Move to thread probes (ADR 0034): arm a restart, read model attempts, rows and Pi sessions, time reads. */
  async #moveProbe(path: string, request: Request): Promise<Response> {
    if (path === '/test/move/crash' || path === '/test/move/pause') {
      const { phase } = Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.Literals(['fork', 'head']) }))(
        await request.json(),
      )
      if (path === '/test/move/crash') this.#crashAt = phase
      else this.#pauseAt = phase
      return Response.json({ armed: phase })
    }
    if (path === '/test/move/paused') return Response.json({ phase: this.#paused?.phase ?? null })
    if (path === '/test/move/resume') {
      this.#paused?.resume()
      return Response.json({ resumed: true })
    }
    if (path === '/test/move/requests')
      return Response.json(
        queueModel(this)
          .requests()
          .map((seen) => seen.messages.flatMap((message) => (message.role === 'system' ? [] : [message.text]))),
      )
    if (path === '/test/move/latency') {
      const { chat, rounds } = Schema.decodeUnknownSync(Schema.Struct({ chat: Schema.String, rounds: Schema.Number }))(
        await request.json(),
      )
      return Response.json(await readRounds(this.harness, new ChatDirectory(drizzle(this.ctx.storage)), chat, rounds))
    }
    return Response.json(await moveState(this.harness, drizzle(this.ctx.storage)))
  }
  protected override mcpFetch(): typeof fetch {
    return this.#mcp.fetch
  }
}
export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    const url = new URL(request.url)
    const input = new Request(new URL(url.pathname + url.search, env.APP_URL), request)
    // The deployed Worker sees its own host; the MCP endpoints check it (DNS-rebinding protection).
    input.headers.set('host', new URL(env.APP_URL).host)
    env = fixtureAuth(request, env)
    try {
      const authProbe = await authFixtureRoute(input, env)
      if (authProbe !== undefined) return authProbe
      if (url.pathname === '/__test/primary-profile') {
        const { userId } = await requireUserSession(input, env)
        return env.AGENTS.getByName(userId).fetch('https://agent/test/primary-profile')
      }
      if (url.pathname.startsWith('/__test/topics/')) {
        const { userId } = await requireUserSession(input, env)
        return env.AGENTS.getByName(userId).fetch(
          new Request(`https://agent/test/topics/${url.pathname.split('/').at(-1)}`, input),
        )
      }
      if (url.pathname === '/__test/retrieval/excerpts') {
        const { userId } = await requireUserSession(input, env)
        return env.AGENTS.getByName(userId).fetch('https://agent/test/retrieval/excerpts')
      }
      if (url.pathname.startsWith('/__test/move/')) {
        const { userId } = await requireUserSession(input, env)
        return env.AGENTS.getByName(userId).fetch(
          new Request(`https://agent/test/move/${url.pathname.split('/').at(-1)}`, input),
        )
      }
      if (url.pathname.startsWith('/__test/queue/')) {
        const { userId } = await requireUserSession(input, env)
        return env.AGENTS.getByName(userId).fetch(
          new Request(`https://agent/test/queue/${url.pathname.split('/').at(-1)}`, input),
        )
      }
      if (url.pathname.startsWith('/__test/approvals/')) {
        const { userId } = await requireUserSession(input, env)
        return env.AGENTS.getByName(userId).fetch(`https://agent/test/approvals/${url.pathname.split('/').at(-1)}`)
      }
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
      return failureResponse(cause, url.pathname, 'owner-fixture')
    }
  },
}
