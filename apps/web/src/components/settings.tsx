import { useBilling } from '../account/hooks.ts'
import { ClientsCard, DeleteAccountCard } from './account-cards.tsx'
import { MemoryCard, ResidentCard, UsageCard } from './agent-cards.tsx'
import { BillingCard } from './billing.tsx'
import { PageSection } from './page-section.tsx'
import { RoutinesSection } from './routines.tsx'

/**
 * The owner's settings, most used first: their plan and today's usage, their agent, routines, how they sign in, the
 * apps that use their agent, and last the account itself. A lapsed plan shows only what still applies.
 */
export function Settings() {
  const active = useBilling().state?.active === true
  return (
    <div className="page-stack">
      <PageSection id="plan" title="Plan and usage">
        <BillingCard />
        {active && <UsageCard />}
      </PageSection>
      {active && (
        <PageSection id="agent" title="Your agent">
          <ResidentCard />
          <MemoryCard />
        </PageSection>
      )}
      {active && <RoutinesSection />}
      {active && (
        <PageSection
          id="clients"
          title="Apps that use your agent"
          note={
            <>
              MCP clients you allowed to use goblin at <code>{`${window.location.origin}/mcp`}</code>.
            </>
          }
        >
          <ClientsCard />
        </PageSection>
      )}
      <PageSection id="account" title="Account">
        <DeleteAccountCard />
      </PageSection>
    </div>
  )
}
