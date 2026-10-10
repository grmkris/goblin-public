import type { NonEmptyReadonlyArray } from 'effect/Array'
import * as HttpApi from 'effect/http-api/HttpApi'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import { AgentGroup } from './agent.ts'
import { AgentAppsGroup } from './agent-apps.ts'
import { AppsGroup } from './apps.ts'
import { ConversationsGroup } from './conversations.ts'
import { API_ERRORS } from './errors.ts'
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
export class OwnerAdmission extends HttpApiMiddleware.Service<OwnerAdmission>()('goblin/api/OwnerAdmission', {
  error: API_ERRORS,
}) {}

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
  .middleware(OwnerAdmission) {}

/**
 * The owner API with only `groups`, under the same id, prefix and gate: a test serves one area's handlers with only
 * the services that area needs (`apps/runtime/test/http/api/serve.ts`).
 */
export const ownerApiOf = <const A extends NonEmptyReadonlyArray<HttpApiGroup.Constraint>>(...groups: A) =>
  HttpApi.make('goblin-owner')
    .add(...groups)
    .prefix('/api')
    .middleware(OwnerAdmission)
