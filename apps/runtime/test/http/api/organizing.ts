import { OrganizeGroup, PersonasGroup, TopicsGroup } from '@goblin/contracts/api'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { AgentApps } from '../../../src/agent-apps/engine.ts'
import type { AppRegistry } from '../../../src/apps/registry.ts'
import { Conversations } from '../../../src/chats/service.ts'
import { RoutineRuns } from '../../../src/routines/service.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { Apps } from '../../../src/apps/service.ts'
import { HomeService } from '../../../src/home/service.ts'
import { delegationServices } from '../../../src/layers/delegation.ts'
import { KeyedLock } from '../../../src/observability/lock.ts'
import { Changes, makeChanges } from '../../../src/runtime/changes.ts'
import { WorkspaceFeed } from '../../../src/workspace/feed.ts'
import { McpConnections, Resident } from '../../../src/mcp/service.ts'
import { FlowEvents } from '../../../src/observability/flows.ts'
import { OrganizeHandlers } from '../../../src/organize/api.ts'
import { PersonasHandlers } from '../../../src/personas/api.ts'
import { OrganizeReceipts } from '../../../src/organize/receipts.ts'
import { PersonaRegistry } from '../../../src/personas/registry.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { TopicsHandlers } from '../../../src/topics/api.ts'
import { TopicRegistry } from '../../../src/topics/registry.ts'
import { currentResident, database, plans, serve, served, stub } from './fixture.ts'

/**
 * The organizing groups (topics, personas, organize) as the agent serves them: lane D's services over real Topic,
 * Persona, receipt and Home stores on SQLite. The gate's plan and resident authority are the only fakes. Nothing here
 * has an open chat to stop, an agent app or an MCP App, so Pi, Stop, the apps and the MCP host are never read.
 */
export const organizing = (options: { readonly active?: boolean } = {}) => {
  const db = database()
  db.insert(appConversations).values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 }).run()
  let sessions = 100
  const topics = new TopicRegistry(db, {
    open: async () => String(sessions++),
    register: (chat, topic, name, now) =>
      void db
        .insert(appConversations)
        .values({
          chatId: chat,
          piSession: chat,
          kind: 'main',
          role: 'conversation',
          title: name,
          topicId: topic,
          createdAt: now,
        })
        .run(),
    activate: async () => undefined,
    seed: async () => undefined,
    retitle: () => undefined,
  })
  const personas = new PersonaRegistry(db, ['model-a', 'model-b'])
  const receipts = new OrganizeReceipts(
    db,
    (kind, target) => (kind.startsWith('topic.') ? topics : personas).get(Number(target)).revision,
  )
  // SAFETY: with no agent apps, Home reads only the engine's (empty) app list and never an App placement or its info.
  const engine = Object.assign(Object.create(null) as AgentApps, { store: { apps: () => [] } })
  // SAFETY: as above, nothing here places an App, so the App registry is never read.
  const home = new HomeService(db, Object.create(null) as AppRegistry, engine)
  // Current, counting the gate's renewals; the organizing programs ask it only to `require` itself.
  const resident = currentResident()
  // SAFETY: what only a Stop of an open chat or an App on Home reads, which no request here reaches.
  const unread = undefined as never
  // A Topic created here has no open chat, so an archive (an Undo of its creation) reads only `openIn`.
  const conversations = stub(Conversations, { openIn: () => Effect.succeed([]) })
  const flows: FlowEvent[] = []
  // The feed reads its sources only for a listener, and none listens here.
  const feed = new WorkspaceFeed(
    unread,
    { conversations: unread, apps: unread, home, topics, personas, invocations: unread, receipts },
    unread,
  )
  const lane = delegationServices({ topics, personas, invocations: unread, receipts, home, feed }).pipe(
    Layer.provide(Layer.merge(KeyedLock.layer, Layer.succeed(Changes, makeChanges()))),
  )
  const { handle, fetch } = serve(
    served(
      [TopicsGroup, PersonasGroup, OrganizeGroup],
      Layer.mergeAll(TopicsHandlers, PersonasHandlers, OrganizeHandlers),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          lane,
          conversations,
          stub(AgentInput),
          stub(RoutineRuns),
          stub(Apps),
          stub(McpConnections),
          Layer.succeed(Resident, resident.service),
          plans(options.active),
          FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
        ),
      ),
    ),
  )
  return { handle, fetch, resident, topics, personas, receipts, home, flows }
}
