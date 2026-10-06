import type { HomeEdit } from '@goblin/contracts'
import { InvalidInput } from '../http/errors.ts'
import { toolAppResource } from '../mcp/connection.ts'
import * as Effect from 'effect/Effect'
import { Apps, Home, Mcp, attempt, attemptSync, requireResident } from '../services.ts'

/** Read the cached call and current declaration before entering the layout transaction. */
const verifyMcpApp = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* Apps
    const placement = yield* attemptSync(() => apps.placement(id))
    if (placement.source !== 'mcp') return
    if (placement.closed) return yield* new InvalidInput({ reason: 'Open the MCP App before putting it on Home' })
    const launch = yield* attempt(() => apps.launch(id))
    if (launch.kind !== 'mcp') return
    const mcp = yield* Mcp
    const snapshot = yield* attempt(() => mcp.manager.connect(launch.serverId))
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

export const readHomeLayout = Effect.andThen(
  requireResident,
  Home.use((home) => attemptSync(() => home.read())),
)
export const editHomeLayout = (input: HomeEdit, actor: 'owner' | 'agent') =>
  Effect.gen(function* () {
    if (actor === 'agent') yield* requireResident
    if (actor === 'owner') {
      const home = yield* Home
      const needsVerification = yield* attemptSync(() => home.needsAppVerification(input, actor))
      if (needsVerification) yield* verifyMcpApps(input)
    }
    return yield* Home.use((home) => attemptSync(() => home.edit(input, actor)))
  })
