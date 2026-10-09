import { createFileRoute } from '@tanstack/react-router'
import { agentAppsQuery } from '../agent-apps/queries.ts'
import { AppsPage } from '../components/apps-page.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { primeOwnerRead } from '../lib/prime.ts'

/** The owner's agent apps (ADR 0021). */
export const Route = createFileRoute('/apps/')({
  loader: ({ context }) => primeOwnerRead(context.queryClient, agentAppsQuery),
  component: AppsRoute,
})
function AppsRoute() {
  return (
    <OwnerGate>
      <PageBar title="Apps" />
      <div className="shell">
        <AppsPage />
      </div>
    </OwnerGate>
  )
}
