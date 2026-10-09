import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** The account's inbound MCP clients, served by the Worker. Endpoints are added the way `topics.ts` adds them. */
export class ClientsGroup extends HttpApiGroup.make('clients') {}
