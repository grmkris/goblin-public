import { OwnerApi } from '@goblin/contracts/api'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { AgentAppsHandlers } from '../../agent-apps/api.ts'
import { AppsHandlers } from '../../apps/api.ts'
import { ConversationsHandlers } from '../../chats/api.ts'
import { InspectHandlers } from '../../inspect/api.ts'
import { McpHandlers } from '../../mcp/api.ts'
import { ResidentHandlers } from '../../mcp/resident-api.ts'
import { MemoryHandlers } from '../../memory/api.ts'
import { OrganizeHandlers } from '../../organize/api.ts'
import { PersonasHandlers } from '../../personas/api.ts'
import { AgentHandlers } from '../../routines/agent-api.ts'
import { RoutinesHandlers } from '../../routines/api.ts'
import { TopicsHandlers } from '../../topics/api.ts'
import { OwnerGateLive } from './middleware.ts'

/** Every owner group's handlers behind the owner gate: the routes the agent serves (`server.ts`). */
export const OwnerApiLayer = HttpApiBuilder.layer(OwnerApi).pipe(
  Layer.provide([
    ConversationsHandlers,
    TopicsHandlers,
    PersonasHandlers,
    OrganizeHandlers,
    McpHandlers,
    ResidentHandlers,
    AgentHandlers,
    MemoryHandlers,
    RoutinesHandlers,
    AppsHandlers,
    AgentAppsHandlers,
    InspectHandlers,
  ]),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)
