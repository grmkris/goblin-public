import { Agent } from 'agents'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { JsonObject } from '@purrable/contracts'
import { PiHarness } from 'agents/harness/pi'
import type { RuntimeEnv } from './env.ts'
import type { VerifiedMcpPrincipal } from './auth/principal.ts'
import { persistResidentPrincipal, residentMcpExtension } from './pi/resident-mcp.ts'
import { makePiHarness } from './pi/harness.ts'
import { piEventResponse } from './pi/events.ts'
import { runApplicationMigrations } from './storage/migrations.ts'

export class PersonalAgent extends Agent<RuntimeEnv> {
  readonly harness: PiHarness

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    this.harness = makePiHarness(env, [residentMcpExtension(env, ctx.storage)])
    this.lifecycle.use(this.harness)
  }

  override async onStart(): Promise<void> {
    runApplicationMigrations(this.ctx.storage)
  }

  async submit(input: string, operationId: string) {
    return this.harness.submit(input, { operationId })
  }

  /** Store safe owner-session metadata; the original credentials never enter Pi state. */
  async submitAuthenticated(input: string, operationId: string, principal: VerifiedMcpPrincipal) {
    await this.lifecycle.start()
    await persistResidentPrincipal(this.env, this.ctx.storage, principal)
    return this.submit(input, operationId)
  }

  async wait(operationId: string) {
    return this.harness.wait(operationId)
  }

  async stop(operationId?: string): Promise<boolean> {
    return operationId === undefined ? this.harness.abort() : this.harness.abort({ operationId })
  }

  async messages(): Promise<readonly EntryRecord[]> {
    return this.harness.messages()
  }

  async sessionSnapshot(): Promise<JsonObject> {
    const stream = await this.harness.session().events()
    const snapshot = stream.snapshot
    await stream.stop()
    // SAFETY: Pi's snapshot is structured cloneable; JSON normalization narrows it to the shared RPC contract.
    return JSON.parse(JSON.stringify(snapshot)) as JsonObject
  }

  async eventsResponse(): Promise<Response> {
    return piEventResponse(await this.harness.session().events())
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/events') return this.eventsResponse()
    if (url.pathname === '/snapshot') return Response.json(await this.sessionSnapshot())
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}
