import { InternalApi } from '@goblin/contracts/internal'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { acceptDoorbell } from '../channel/program.ts'
import { Inspection } from '../inspect/service.ts'
import { Events } from '../mcp/service.ts'
import { askClient, recentOwnerMessages } from './program.ts'

/**
 * The internal API's `inbound` group: what the Worker brings the agent after its own check (a client's bearer token, a
 * hook's route token). The internal gate has already refused an owner forward and checked the plan where the endpoint
 * needs one. The doorbell is answered at once: the pull runs from a schedule.
 */
export const InboundHandlers = HttpApiBuilder.group(InternalApi, 'inbound', (handlers) =>
  handlers
    .handle('ask', ({ payload }) => askClient(payload))
    .handle('recent', ({ query }) => recentOwnerMessages(query.limit))
    .handle('doorbell', ({ payload }) => acceptDoorbell(payload))
    .handle('mcpEvents', ({ payload, headers }) =>
      Events.use((events) =>
        events.receive({
          body: payload,
          subscriptionId: headers['x-mcp-subscription-id'],
          id: headers['webhook-id'],
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
        }),
      ),
    )
    .handle('inspect', ({ payload }) => Inspection.use((inspection) => inspection.run(payload.query))),
)
