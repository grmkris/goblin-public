import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { Settings } from '../components/settings.tsx'
import { clientsQuery } from '../account/queries.ts'
import { memoryQuery, residentQuery, usageQuery } from '../agent/queries.ts'
import { primeOwnerRead } from '../lib/prime.ts'
import { routineSettingsQuery, routinesQuery } from '../routines/queries.ts'

/** The settings' cards start loading before the page renders; a lapsed plan's refusals are the cards' to show. */
export const Route = createFileRoute('/settings')({
  loader: async ({ context }) => {
    await Promise.all([
      primeOwnerRead(context.queryClient, usageQuery),
      primeOwnerRead(context.queryClient, residentQuery),
      primeOwnerRead(context.queryClient, memoryQuery()),
      primeOwnerRead(context.queryClient, routinesQuery),
      primeOwnerRead(context.queryClient, routineSettingsQuery),
      primeOwnerRead(context.queryClient, clientsQuery),
    ])
  },
  component: SettingsPage,
})
function SettingsPage() {
  return (
    <OwnerGate planRequired={false}>
      <PageBar title="Settings" />
      <div className="shell">
        <Settings />
      </div>
    </OwnerGate>
  )
}
