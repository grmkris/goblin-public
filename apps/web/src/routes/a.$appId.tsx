import { createFileRoute, redirect } from '@tanstack/react-router'
import { AppPage } from '../components/apps/page.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

/** An App as a page of its own in the main column, with the way back to its channel. */
export const Route = createFileRoute('/a/$appId')({
  beforeLoad: ({ params }) => {
    if (!/^\d{1,12}$/u.test(params.appId)) throw redirect({ to: '/' })
  },
  component: AppRoute,
})

function AppRoute() {
  const { appId } = Route.useParams()
  return (
    <OwnerGate>
      <AppPage id={appId} />
    </OwnerGate>
  )
}
