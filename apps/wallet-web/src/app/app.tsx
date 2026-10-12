import { useConnections, useMe } from '../api/queries.tsx'
import { ActivityPage } from '../pages/activity.tsx'
import { ApprovePage } from '../pages/approve.tsx'
import { ConsentPage } from '../pages/consent.tsx'
import { ConnectionsPage } from '../pages/connections.tsx'
import { HomePage } from '../pages/home.tsx'
import { LimitsPage } from '../pages/limits.tsx'
import { OnboardingPage, readSkipped } from '../pages/onboarding.tsx'
import { setupProgress } from '../pages/progress.ts'
import { SignInPage } from '../pages/sign-in.tsx'
import { Async, LoadingBlock } from '../ui/async.tsx'
import { useAuth } from './auth.tsx'
import { useLocation } from './router.tsx'
import { Shell } from './shell.tsx'

function Routes() {
  const { pathname } = useLocation()
  if (pathname === '/activity') return <ActivityPage />
  if (pathname === '/limits') return <LimitsPage />
  if (pathname === '/connections') return <ConnectionsPage />
  return <HomePage />
}

/** Setup first: until the wallet is created, upgraded, allowed and connected (or skipped), every page is the wizard. */
function SignedIn() {
  const auth = useAuth()
  const me = useMe()
  const connections = useConnections()
  return (
    <Async query={me} rows={2}>
      {(data) => (
        <Shell owner={data.owner} onSignOut={auth.logout}>
          {connections.isPending ? (
            <LoadingBlock rows={2} />
          ) : setupProgress(data, {
              connected: (connections.data?.length ?? 0) > 0,
              skipped: readSkipped(),
              // Funding orders the steps before the upgrade only; whether setup is done never waits on a balance.
              funded: undefined,
            }) === 'done' ? (
            <Routes />
          ) : (
            <OnboardingPage me={data} />
          )}
        </Shell>
      )}
    </Async>
  )
}

export function App() {
  const auth = useAuth()
  const { pathname } = useLocation()
  if (auth.status !== 'ready') return <SignInPage />
  if (pathname === '/consent') return <ConsentPage />
  if (pathname.startsWith('/approve/'))
    return <ApprovePage operationId={decodeURIComponent(pathname.slice('/approve/'.length))} />
  return <SignedIn />
}
