import * as Effect from 'effect/Effect'
import { type AgentFetch, deliverEvents } from '../../src/inbound/client.ts'
import type { EventWebhook } from '../../src/mcp/events.ts'

/** A webhook for a subscription the agent does not know: ingress answers it from the authority checks alone. */
const WEBHOOK: EventWebhook = {
  body: new Uint8Array(),
  subscriptionId: 'remote-transient',
  id: 'evt_transient',
  timestamp: '0',
  signature: '',
}

/** The status the agent answered the webhook with, as the Worker's Events route delivers it, or the failure's tag. */
const answer = (agent: AgentFetch): Promise<number | string> =>
  Effect.runPromise(
    deliverEvents(agent, WEBHOOK).pipe(
      Effect.map(({ status }) => status),
      // expected: the case answers the failure's tag, for the native test to assert on
      Effect.catch((error) => Effect.succeed(error._tag)),
    ),
  )

/**
 * Events ingress (M1) on the native agent, through its internal API as the Worker's Events route reaches it. The
 * internal gate's plan lookup fails once (`failPlanCheck(1)` arms the next lookup to fail with Internal): the sender is
 * answered 503, so it keeps the subscription and retries. The owner's own refusal (resident authority revoked) answers
 * 410, which ends it. Both are decided before any subscription row is read.
 */
export async function eventsIngressCase(
  agent: AgentFetch,
  failPlanCheck: (nth: number) => void,
  revokeResident: () => Promise<void>,
): Promise<{ readonly transient: number | string; readonly revoked: number | string }> {
  failPlanCheck(1)
  const transient = await answer(agent)
  await revokeResident()
  const revoked = await answer(agent)
  return { transient, revoked }
}
