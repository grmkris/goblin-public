import { useMe } from '../api/queries.tsx'
import { ActivityPage } from '../pages/activity.tsx'
import { AddFundsPage } from '../pages/add-funds.tsx'
import { ApprovePage } from '../pages/approve.tsx'
import { ConsentPage } from '../pages/consent.tsx'
import { ConnectionsPage } from '../pages/connections.tsx'
import { HomePage } from '../pages/home.tsx'
import { WalletLanding } from '../pages/landing/landing.tsx'
import { LimitsPage } from '../pages/limits.tsx'
import { SetupPage } from '../pages/setup/setup-page.tsx'
import { SignInPage } from '../pages/sign-in.tsx'
import { SubscribePage } from '../pages/subscribe.tsx'
import { Async } from '../ui/async.tsx'
import { useAuth } from './auth.tsx'
import { frontDoor, returningOwner } from './front-door.ts'
import { useLocation } from './router.tsx'
import { type ConsolePageName, routeOf } from './routes.ts'
import { Shell } from './shell.tsx'

function ConsolePage({ page }: { readonly page: ConsolePageName }) {
  switch (page) {
    case 'activity':
      return <ActivityPage />
    case 'limits':
      return <LimitsPage />
    case 'connections':
      return <ConnectionsPage />
    case 'add-funds':
      return <AddFundsPage />
    case 'home':
      return <HomePage />
  }
}

/** Whatever the storage hint says once, at load: it guides only the first moments while Privy loads. */
const RETURNING = returningOwner(() => window.localStorage)

/**
 * The console: every page works whether or not setup is finished, so its navigation always goes somewhere. Home says
 * what setup still needs and links to /setup; the other pages show what there is.
 */
function SignedIn({ page }: { readonly page: ConsolePageName }) {
  const auth = useAuth()
  const me = useMe()
  return (
    <Async query={me} rows={2}>
      {(data) => (
        <Shell owner={data.owner} onSignOut={auth.logout}>
          <ConsolePage page={page} />
        </Shell>
      )}
    </Async>
  )
}

export function App() {
  const auth = useAuth()
  const { pathname } = useLocation()
  if (auth.status !== 'ready')
    return frontDoor({ pathname, status: auth.status, returning: RETURNING }) === 'landing' ? (
      <WalletLanding />
    ) : (
      <SignInPage />
    )
  const route = routeOf(pathname)
  if (route.page === 'setup') return <SetupPage />
  if (route.page === 'consent') return <ConsentPage />
  if (route.page === 'approve') return <ApprovePage operationId={route.operationId} />
  if (route.page === 'subscribe') return <SubscribePage subscriptionId={route.subscriptionId} />
  return <SignedIn page={route.page} />
}
