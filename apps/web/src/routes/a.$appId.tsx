import { createFileRoute, redirect } from '@tanstack/react-router'
import { AppPage } from '../components/apps/page.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { parseFocus } from '../lib/app-focus.ts'

/**
 * An App as a page of its own in the main column (ADRs 0020, 0053), with the way back to its conversation and the chat
 * bar for it; a server's own App opens on the panel `?focus=` names.
 */
export const Route = createFileRoute('/a/$appId')({
  validateSearch: parseFocus,
  beforeLoad: ({ params }) => {
    if (!/^\d{1,12}$/u.test(params.appId)) throw redirect({ to: '/' })
  },
  component: AppRoute,
})

function AppRoute() {
  const { appId } = Route.useParams()
  const { focus } = Route.useSearch()
  return (
    <OwnerGate>
      <AppPage id={appId} {...(focus === undefined ? {} : { focus })} />
    </OwnerGate>
  )
}
