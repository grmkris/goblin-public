import type { RpcResult } from '../../src/http/rpc.ts'
import type { EventWebhook, EventWebhookResult } from '../../src/mcp/events.ts'

/** The agent as the Worker's Events route reaches it (`/hooks/mcp-events/…`). */
export type WebhookAgent = {
  readonly mcpEventsWebhook: (input: EventWebhook) => Promise<RpcResult<EventWebhookResult>>
}

/** A webhook for a subscription the agent does not know: ingress answers it from the authority check alone. */
const WEBHOOK: EventWebhook = {
  body: new Uint8Array(),
  subscriptionId: 'remote-transient',
  id: 'evt_transient',
  timestamp: '0',
  signature: '',
}

/** The status the agent answered the webhook with, or the tag of the failure it answered instead. */
const answer = async (agent: WebhookAgent): Promise<number | string> => {
  const result = await agent.mcpEventsWebhook(WEBHOOK)
  return result.ok ? result.value.status : result.error._tag
}

/**
 * Events ingress (M1) on the native agent. The plan lookup behind the webhook fails once, after the request's own
 * plan check passed (`failPlanCheck(2)` arms the second lookup to fail with Internal): the agent answers 503, so the
 * sender keeps the subscription and retries. The owner's own refusal (resident authority revoked) answers 410, which
 * ends it. Both are decided before any subscription row is read.
 */
export async function eventsIngressCase(
  agent: WebhookAgent,
  failPlanCheck: (nth: number) => void,
  revokeResident: () => Promise<void>,
): Promise<{ readonly transient: number | string; readonly revoked: number | string }> {
  failPlanCheck(2)
  const transient = await answer(agent)
  await revokeResident()
  const revoked = await answer(agent)
  return { transient, revoked }
}
