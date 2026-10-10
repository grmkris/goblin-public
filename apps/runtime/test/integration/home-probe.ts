import { createRegistry } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { HomeLayout, type HomeEdit, type HomeOperation } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { agentApps } from '../../src/agent-apps/engine.ts'
import {
  type AppSources,
  agentAppChanged,
  agentAppId,
  appList,
  closeWithConversations,
  keepApp,
  removeAgentApp,
  setAppClosed,
} from '../../src/apps/registry.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { appConversations } from '../../src/storage/schema.ts'
import { InvalidInput } from '../../src/http/errors.ts'
import { HomeService } from '../../src/home/service.ts'
import { readHome } from '../../src/home/store.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { memorySchedules, probeLocal } from './apps-jobs-probe.ts'

const APP = `import { defineApp, s } from '@goblin/app'
export type State = { count: number }
export default defineApp({ name: 'home-list', title: 'Reading list', description: 'Keeps books',
state: { schema: s.object({ count: s.number({ int: true }) }), initial: { count: 0 } },
actions: { add: { description: 'Add one.', input: s.object({}), run: (input, ctx) => ({ count: ctx.state.count + 1 }) } }, views: {} })`
const VIEW = `import { useAppState } from '@goblin/app'
import type { State } from './app'
export default function View() { const [state] = useAppState<State>(); return <p>Books: {state.count}</p> }`
const rejected = (work: () => void): boolean => {
  try {
    work()
    return false
  } catch {
    // expected: the probe answers whether the edit was refused
    return true
  }
}
const boundsRejected = (kind: 'app' | 'conversations', length: number) =>
  rejected(() =>
    Schema.decodeUnknownSync(HomeLayout)({
      revision: 0,
      tiles: Array.from({ length }, (_, i) => ({
        kind,
        id: String(i),
        appId: String(i),
        size: 'small',
        placedBy: 'agent',
      })),
    }),
  )
const hasApp = (tile: HomeLayout['tiles'][number]) => tile.kind === 'app'
function mcpPlacementProbe(home: HomeService, apps: AppSources, db: ReturnType<typeof drizzle>) {
  const edit = (
    operationId: string,
    expectedRevision: number,
    ops: readonly HomeOperation[],
    actor: 'owner' | 'agent' = 'agent',
  ) => home.edit({ operationId, expectedRevision, ops }, actor)
  const origin = { serverId: 'home-fixture', tool: 'board', uri: 'ui://home-fixture/board', title: 'Board' }
  const mcp = keepApp(db, apps, { session: '1', callId: 'home-board', origin }, 3)
  let agentMcpReason = ''
  try {
    edit('home-agent-mcp', 6, [{ kind: 'add', tile: { kind: 'app', id: 'mcp-board', appId: mcp.id, size: 'medium' } }])
  } catch (cause) {
    // expected: the probe answers with the reason the agent's MCP tile was refused
    if (cause instanceof InvalidInput) agentMcpReason = cause.reason
  }
  const ownerMcp = edit(
    'home-owner-mcp',
    6,
    [{ kind: 'add', tile: { kind: 'app', id: 'mcp-board', appId: mcp.id, size: 'medium' } }],
    'owner',
  )
  setAppClosed(db, apps.agents, mcp.id, true, 4)
  const afterClose = edit('home-after-close', 7, [
    { kind: 'update', id: 'today', title: 'Today', markdown: 'Still editable' },
  ])
  const closedAddRejected = rejected(() =>
    edit(
      'home-add-closed',
      8,
      [
        { kind: 'remove', id: 'mcp-board' },
        { kind: 'add', tile: { kind: 'app', id: 'mcp-board-again', appId: mcp.id, size: 'medium' } },
      ],
      'owner',
    ),
  )
  db.insert(appConversations)
    .values({ chatId: '222', piSession: '222', kind: 'thread', parentSession: '1', createdAt: 1 })
    .run()
  const threaded = keepApp(db, apps, { session: '222', callId: 'home-thread-board', origin }, 4)
  edit(
    'home-owner-thread-mcp',
    8,
    [{ kind: 'add', tile: { kind: 'app', id: 'thread-board', appId: threaded.id, size: 'medium' } }],
    'owner',
  )
  db.update(appConversations).set({ closedAt: 5 }).where(eq(appConversations.chatId, '222')).run()
  closeWithConversations(db, apps, ['222'], 5)
  const afterThreadClose = edit('home-after-thread-close', 9, [{ kind: 'resize', id: 'today', size: 'large' }])
  const threadClosed = appList(db, apps.agents).find((app) => app.id === threaded.id)?.closedAt !== undefined
  return { agentMcpReason, ownerMcp, afterClose, closedAddRejected, afterThreadClose, threadClosed }
}

/** Native SQLite, a real Dynamic Worker app, atomic receipts, and reconstruction over retained rows. */
export async function homeProbe(storage: DurableObjectStorage, env: RuntimeEnv, owner: string, _harness: PiHarness) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const engine = agentApps(storage, env, () => owner, { schedules: memorySchedules(), local: probeLocal })
  engine.attach(createRegistry())
  engine.restore()
  const apps: AppSources = {
    agents: {
      info: (name) => engine.info(name),
      launch: (name) => engine.launch(name),
      rehome: () => undefined,
    },
    chats: new ChatDirectory(db),
  }
  engine.onChange((name) => agentAppChanged(db, apps, name, 1))
  const home = new HomeService(db, engine)
  const edit = (
    operationId: string,
    expectedRevision: number,
    ops: readonly HomeOperation[],
    actor: 'owner' | 'agent' = 'agent',
  ) => home.edit({ operationId, expectedRevision, ops }, actor)
  const firstInput: HomeEdit = {
    operationId: 'home-first',
    expectedRevision: 0,
    ops: [
      { kind: 'add', tile: { kind: 'note', id: 'today', size: 'medium', title: 'Today', markdown: 'Read a book' } },
    ],
  }
  const first = home.edit(firstInput, 'agent')
  const replay = home.edit(firstInput, 'agent')
  const stale = edit('home-stale', 0, [{ kind: 'remove', id: 'today' }])
  const ownerTile = edit(
    'home-owner',
    1,
    [{ kind: 'add', tile: { kind: 'conversations', id: 'recent', size: 'medium' } }],
    'owner',
  )
  const asked = edit('home-ask', 2, [
    { kind: 'remove', id: 'today' },
    { kind: 'remove', id: 'recent' },
  ])
  const atomicAsk = home.layout().tiles.length === 2
  const changed = edit('home-change', 2, [
    { kind: 'resize', id: 'today', size: 'large' },
    { kind: 'move', id: 'today', index: 1 },
  ])
  const undo = home.edit({ operationId: 'home-undo', expectedRevision: 3, ops: [], undoOf: 'home-change' }, 'owner')
  const invalid = rejected(() =>
    edit('home-invalid', 4, [
      { kind: 'remove', id: 'today' },
      { kind: 'add', tile: { kind: 'app', appId: '999', id: 'missing', size: 'small' } },
    ]),
  )
  const atomicInvalid = home.layout().revision === 4 && home.layout().tiles[0]?.id === 'today'
  const bounded = boundsRejected('conversations', 25)
  const utf8 = rejected(() =>
    edit('home-utf8', 4, [{ kind: 'update', id: 'today', title: 'Today', markdown: '🦉'.repeat(1025) }]),
  )
  const built = await engine.build(
    { name: 'home-list', files: { 'app.ts': APP, 'view.tsx': VIEW } },
    { session: '1', callId: 'home-build' },
  )
  const id = agentAppId(db, 'home-list')
  if (built.status !== 'active' || id === null) return { built }
  edit('home-app', 4, [{ kind: 'add', tile: { kind: 'app', id: 'reading', appId: id, size: 'medium' } }])
  const duplicate = rejected(() =>
    edit('home-duplicate', 5, [{ kind: 'add', tile: { kind: 'app', id: 'reading-again', appId: id, size: 'small' } }]),
  )
  const eight = boundsRejected('app', 9)
  setAppClosed(db, apps.agents, id, true, 2)
  const closePreserved = home.layout().tiles.some(hasApp)
  await engine.remove('home-list')
  removeAgentApp(db, 'home-list')
  const erased = !home.layout().tiles.some(hasApp)
  const mcpPlacement = mcpPlacementProbe(home, apps, db)
  const reconstructed = new HomeService(drizzle(storage), engine)
  return {
    first,
    replay,
    stale,
    ownerTile,
    asked,
    atomicAsk,
    changed,
    undo,
    invalid,
    atomicInvalid,
    bounded,
    utf8,
    duplicate,
    eight,
    closePreserved,
    erased,
    ...mcpPlacement,
    retained: reconstructed.layout(),
  }
}
export const retainedHome = (storage: DurableObjectStorage) => readHome(drizzle(storage))
