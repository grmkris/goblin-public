import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import type { RoutineDefinition } from '@goblin/contracts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { McpHost, McpHostInstance } from '../../src/mcp/host.ts'
import { RoutineStore } from '../../src/routines/store.ts'
import { RoutineRunStore } from '../../src/routines/runs.ts'
import { notifyRoutine } from '../../src/routines/notifications.ts'
import { ResidentAuthority } from '../../src/resident.ts'
import { TelegramChannel } from '../../src/channel/channel.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { Entitlements } from '../../src/billing/gates.ts'
import { channelOver, routineRunsOf } from '../../src/layers/routines.ts'
import { RoutineRuns as RoutineRunsService } from '../../src/routines/service.ts'
import { McpConnectionsLive, ResidentLive } from '../../src/layers/mcp.ts'
import { Db } from '../../src/runtime/db.ts'
import type { AppError } from '../../src/http/errors.ts'
import { Channel as ChannelService } from '../../src/channel/service.ts'
import type { Resident as ResidentService } from '../../src/mcp/service.ts'
import { AgentInput, type AgentInputs } from '../../src/runtime/input.ts'

/** What the dispatch check reads. */
type LaneServices = Entitlements | ResidentService | ChannelService
import { MemoryCredentials, MemoryGrants } from '../mcp/memory.ts'
import { appRoutineRuns } from '../../src/storage/routines.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const fixturePlan = () =>
  Effect.succeed({
    active: true,
    source: 'override' as const,
    until: null,
    dailyCredits: 300_000,
    status: 'fixture',
    hasCustomer: false,
    cancelAtPeriodEnd: false,
  })
function notificationHandler(calls: Record<string, unknown>[]) {
  return createMcpHandler(() => {
    // oxlint-disable-next-line typescript/no-deprecated -- low-level official Server keeps this injected transport fixture independent of schema-library adapters.
    const server = new Server({ name: 'notification-fixture', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({
      tools: [{ name: 'send_message', inputSchema: { type: 'object' } }],
    }))
    server.setRequestHandler('tools/call', (request) => {
      calls.push(request.params.arguments ?? {})
      return { content: [], structuredContent: { id: 'fixture-remote-id', delivery: 'accepted' } }
    })
    return server
  })
}

function notificationHost(
  credentials: MemoryCredentials,
  attempts: Record<string, unknown>[],
  accepted: Record<string, unknown>[],
) {
  const handler = notificationHandler(accepted)
  const host = new McpHost({
    servers: [{ serverId: 'mygram', endpoint: 'https://notification.test/mcp' }],
    appUrl: 'https://goblin.test',
    credentials,
    grants: new MemoryGrants([{ serverId: 'mygram', capability: 'tool', name: 'send_message' }]),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST') {
        const body: { method?: string; params?: { arguments?: Record<string, unknown> } } = await request.clone().json()
        if (body.method === 'tools/call') {
          attempts.push(body.params?.arguments ?? {})
          if (attempts.length === 1) return new Response(null, { status: 503 })
        }
      }
      return handler.fetch(request)
    },
  })
  return host
}
async function setupNotifications(storage: DurableObjectStorage, owner: string) {
  const db = drizzle(storage)
  const routines = new RoutineStore(db, owner)
  const runs = new RoutineRunStore(db, owner)
  const resident = new ResidentAuthority(db)
  resident.enable(Math.floor(Date.now() / 1000))
  const channel = new TelegramChannel(
    db,
    await CredentialCipher.fromBase64(KEY),
    () => undefined,
    undefined,
    new ChatDirectory(db),
  )
  channel.enableEvents('mygram', '', Math.floor(Date.now() / 1000))
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('mygram', { access_token: 'keyless-fixture', token_type: 'bearer' }, 1)
  const attempts: Record<string, unknown>[] = []
  const accepted: Record<string, unknown>[] = []
  const host = notificationHost(credentials, attempts, accepted)
  // The services notifyRoutine reads, over these instances as the agent's layers build them.
  const services = Layer.mergeAll(
    Layer.succeed(RoutineRunsService, routineRunsOf(runs)),
    Layer.succeed(ChannelService, channelOver(channel)),
    McpConnectionsLive,
    ResidentLive,
  ).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(McpHostInstance, host), Layer.succeed(Db, db))))
  const plans = { state: fixturePlan, require: fixturePlan }
  // The bridge's `local`, which notifyRoutine runs its last-moment check through, over the same services.
  const input: AgentInputs = Object.assign(Object.create(null), {
    local: (program: Effect.Effect<void, AppError, LaneServices>) =>
      Effect.runPromise(program.pipe(Effect.provide(services), Effect.provideService(Entitlements, plans))),
  })
  const notify = (id: string) =>
    Effect.runPromise(
      notifyRoutine(runs.get(id)).pipe(
        Effect.provide(services),
        Effect.provideService(Entitlements, plans),
        Effect.provideService(AgentInput, input),
      ),
    )
  return { db, routines, runs, resident, channel, host, attempts, accepted, notify }
}
function createNotification(routines: RoutineStore, runs: RoutineRunStore, id: string, notifyTelegram: boolean) {
  const definition: RoutineDefinition = {
    title: 'Notification fixture',
    prompt: 'Short report.',
    timezone: 'UTC',
    notifyTelegram,
    allowedTools: [],
    trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  }
  const row = routines.propose(definition, `propose-${id}`, `rt_${id}`, Date.now()).routine
  routines.confirm(row.id, 1, `confirm-${id}`, Date.now())
  routines.markActive(row.id, 1, null, Date.now())
  const claimed = runs.claim(
    { routineId: row.id, revision: 1, operationId: `run-${id}`, source: 'manual', firedAt: Date.now() },
    `rr_${id}`,
    undefined,
    Date.now(),
  ).run
  runs.settle(claimed.id, 'completed', 'Useful result <safe> api_key=sample-key', Date.now())
  runs.reported(claimed.id, Date.now())
  return claimed.id
}

/** Native SQLite receipts and official SDK; all sends remain in the injected fixture. */
export async function routineNotificationProbe(storage: DurableObjectStorage, owner: string) {
  runApplicationMigrations(storage)
  const { db, routines, runs, host, attempts, accepted, notify } = await setupNotifications(storage, owner)
  try {
    const off = createNotification(routines, runs, 'notify-off', false)
    await notify(off)
    const offCalls = attempts.length
    const on = createNotification(routines, runs, 'notify-on', true)
    await notify(on)
    const failed = runs.get(on)
    db.update(appRoutineRuns).set({ notificationNextAt: 0 }).where(eq(appRoutineRuns.id, on)).run()
    await notify(on)
    const delivered = runs.get(on)
    await notify(on)
    return {
      offCalls,
      frozenServer: failed.notificationServerId,
      retryState: failed.notificationState,
      attempts: attempts.length,
      stableBytes: JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]),
      accepted: accepted.length,
      state: delivered.notificationState,
      metadata: JSON.parse(delivered.notificationReceipt ?? '{}'),
      scrubbed: delivered.summary,
      reported: delivered.reportAcceptedAt !== null,
    }
  } finally {
    await host.manager.closeAll()
  }
}
