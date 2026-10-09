import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import { AgentGroup } from './agent.ts'
import { AgentAppsGroup } from './agent-apps.ts'
import { AppsGroup } from './apps.ts'
import { ConversationsGroup } from './conversations.ts'
import { API_ERRORS } from './errors.ts'
import { HomeGroup } from './home.ts'
import { InspectGroup } from './inspect.ts'
import { McpGroup } from './mcp.ts'
import { MemoryGroup } from './memory.ts'
import { OrganizeGroup } from './organize.ts'
import { PersonasGroup } from './personas.ts'
import { ResidentGroup } from './resident.ts'
import { RoutinesGroup } from './routines.ts'
import { TopicsGroup } from './topics.ts'

/**
 * Admission to every owner endpoint, run by the agent before the handler: the account's plan, then a renewal of
 * resident authority. Its implementation lives in the runtime (`http/api/middleware.ts`); clients need none. Its error
 * schema is every envelope, so a handler may fail with any `AppError` and the client decodes it.
 */
export class OwnerGate extends HttpApiMiddleware.Service<OwnerGate>()('goblin/api/OwnerGate', { error: API_ERRORS }) {}

/**
 * The owner's API, served by their own agent (the Durable Object) behind the Worker's session, origin, CSRF and plan
 * checks. One group per area, each in its own file; every path is under `/api`.
 */
export class OwnerApi extends HttpApi.make('goblin-owner')
  .add(
    ConversationsGroup,
    TopicsGroup,
    PersonasGroup,
    OrganizeGroup,
    HomeGroup,
    McpGroup,
    ResidentGroup,
    AgentGroup,
    MemoryGroup,
    RoutinesGroup,
    AppsGroup,
    AgentAppsGroup,
    InspectGroup,
  )
  .prefix('/api')
  .middleware(OwnerGate) {}
