import { OwnerApi } from '@goblin/contracts/api'
import { InternalApi } from '@goblin/contracts/internal'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { AgentAppsHandlers } from '../../agent-apps/api.ts'
import { AppsHandlers } from '../../apps/api.ts'
import { ConversationsHandlers } from '../../chats/api.ts'
import { DecisionsHandlers } from '../../decisions/api.ts'
import { FilesHandlers } from '../../files/api.ts'
import { InboundHandlers } from '../../inbound/api.ts'
import { InspectHandlers } from '../../inspect/api.ts'
import { McpHandlers } from '../../mcp/api.ts'
import { ResidentHandlers } from '../../mcp/resident-api.ts'
import { MemoryHandlers } from '../../memory/api.ts'
import { OrganizeHandlers } from '../../organize/api.ts'
import { PersonasHandlers } from '../../personas/api.ts'
import { AgentHandlers } from '../../routines/agent-api.ts'
import { RoutinesHandlers } from '../../routines/api.ts'
import { SetupHandlers } from '../../setup/api.ts'
import { SidebarHandlers } from '../../sidebar/api.ts'
import { TopicsHandlers } from '../../topics/api.ts'
import { NoticesHandlers } from '../../notices/api.ts'
import { OnboardingHandlers } from '../../onboarding/api.ts'
import { WorkspaceHandlers } from '../../workspace/api.ts'
import { InternalGateLive, OwnerAdmissionLive } from './middleware.ts'

/** Every owner group's handlers behind owner admission. */
const OwnerApiLayer = HttpApiBuilder.layer(OwnerApi).pipe(
  Layer.provide([
    ConversationsHandlers,
    TopicsHandlers,
    SetupHandlers,
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
    WorkspaceHandlers,
    FilesHandlers,
    DecisionsHandlers,
    NoticesHandlers,
    OnboardingHandlers,
    SidebarHandlers,
  ]),
  Layer.provide(OwnerAdmissionLive),
)

/** The internal API's handlers behind the internal gate. */
const InternalApiLayer = HttpApiBuilder.layer(InternalApi).pipe(
  Layer.provide(InboundHandlers),
  Layer.provide(InternalGateLive),
)

/** The routes the agent serves (`server.ts`): both APIs on one router. */
export const AgentApiLayer = Layer.mergeAll(OwnerApiLayer, InternalApiLayer).pipe(
  Layer.provide(HttpServer.layerServices),
)
