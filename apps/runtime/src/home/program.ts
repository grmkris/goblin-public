import type { HomeEdit } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Apps } from '../apps/service.ts'
import { InvalidInput } from '../http/errors.ts'
import { toolAppResource } from '../mcp/remote.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import { Home } from './service.ts'

/** Read the cached call and current declaration before entering the layout transaction. */
const verifyMcpApp = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* Apps
    const placement = yield* apps.placement(id)
    if (placement.source !== 'mcp') return
    if (placement.closed) return yield* new InvalidInput({ reason: 'Open the MCP App before putting it on Home' })
    const launch = yield* apps.launch(id)
    if (launch.kind !== 'mcp') return
    const snapshot = yield* McpConnections.use((connections) => connections.connect(launch.serverId))
    const tool = snapshot.tools.find(({ name }) => name === placement.tool)
    if (tool === undefined || toolAppResource(tool) !== launch.uri)
      return yield* new InvalidInput({ reason: 'The tool no longer declares this MCP App' })
  })

const verifyMcpApps = (input: HomeEdit) =>
  Effect.forEach(
    input.ops.flatMap((op) => (op.kind === 'add' && op.tile.kind === 'app' ? [op.tile.appId] : [])),
    verifyMcpApp,
    { discard: true },
  )

/** Fails with `ResidentInactive` unless the owner's resident authority is current. */

export const readHomeLayout = Effect.andThen(
  requireResident,
  Home.use((home) => home.read),
)
export const editHomeLayout = (input: HomeEdit, actor: 'owner' | 'agent') =>
  Effect.gen(function* () {
    if (actor === 'agent') yield* requireResident
    const home = yield* Home
    if (actor === 'owner' && (yield* home.needsAppVerification(input, actor))) yield* verifyMcpApps(input)
    return yield* home.edit(input, actor)
  })
