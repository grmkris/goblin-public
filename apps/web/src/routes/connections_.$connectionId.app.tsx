import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { ServerAppPage } from '../components/server-app.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { serversQuery } from '../mcp/queries.ts'

/** A first-class server's own App as a page (ADR 0043), opened from its card or a paid-job card. */
export const Route = createFileRoute('/connections_/$connectionId/app')({
  loader: async ({ context }) => {
    await primeOwnerRead(context.queryClient, serversQuery)
  },
  component: ServerAppRoute,
})

function ServerAppRoute() {
  const { connectionId } = Route.useParams()
  return (
    <OwnerGate>
      <ServerAppPage connectionId={connectionId} />
    </OwnerGate>
  )
}
