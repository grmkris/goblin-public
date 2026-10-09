import { createFileRoute } from '@tanstack/react-router'
import { Connections } from '../components/connections.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { channelQuery } from '../agent/queries.ts'
import { primeOwnerRead } from '../lib/prime.ts'
import { serversQuery, suggestedQuery } from '../mcp/queries.ts'

/** The owner's servers, the Telegram channel and the suggestions start loading before the page renders. */
export const Route = createFileRoute('/connections')({
  loader: async ({ context }) => {
    await Promise.all([
      primeOwnerRead(context.queryClient, serversQuery),
      primeOwnerRead(context.queryClient, channelQuery),
      primeOwnerRead(context.queryClient, suggestedQuery),
    ])
  },
  component: ConnectionsPage,
})
function ConnectionsPage() {
  return (
    <OwnerGate>
      <PageBar title="Connections" />
      <div className="shell">
        <Connections />
      </div>
    </OwnerGate>
  )
}
