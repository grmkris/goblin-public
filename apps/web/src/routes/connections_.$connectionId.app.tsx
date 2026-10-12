import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { ServerAppPage } from '../components/server-app.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { serversQuery } from '../mcp/queries.ts'

/** An App panel to open on, such as the Goblin Wallet's `add_funds`: letters and underscores only. */
const parseFocus = (search: Record<string, unknown>): { readonly focus?: string } =>
  typeof search['focus'] === 'string' && /^[a-z_]{1,32}$/u.test(search['focus']) ? { focus: search['focus'] } : {}

/**
 * A first-class server's own App as a page (ADR 0043), opened from its card, a paid-job card or Start, which opens the
 * Goblin Wallet on Add funds (`?focus=add_funds`).
 */
export const Route = createFileRoute('/connections_/$connectionId/app')({
  validateSearch: parseFocus,
  loader: async ({ context }) => {
    await primeOwnerRead(context.queryClient, serversQuery)
  },
  component: ServerAppRoute,
})

function ServerAppRoute() {
  const { connectionId } = Route.useParams()
  const { focus } = Route.useSearch()
  return (
    <OwnerGate>
      <ServerAppPage connectionId={connectionId} {...(focus === undefined ? {} : { focus })} />
    </OwnerGate>
  )
}
