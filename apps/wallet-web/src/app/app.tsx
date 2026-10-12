import { useMe } from '../api/queries.tsx'
import { ActivityPage } from '../pages/activity.tsx'
import { ApprovePage } from '../pages/approve.tsx'
import { ConsentPage } from '../pages/consent.tsx'
import { ConnectionsPage } from '../pages/connections.tsx'
import { HomePage } from '../pages/home.tsx'
import { LimitsPage } from '../pages/limits.tsx'
import { OnboardingPage } from '../pages/onboarding.tsx'
import { isSetUp } from '../pages/progress.ts'
import { SignInPage } from '../pages/sign-in.tsx'
import { Async } from '../ui/async.tsx'
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

/**
 * Setup first: until the agent has a wallet and the account is upgraded and allowed on Base, every page is the setup
 * screen. Connecting an agent never gates it; the Connections page has the MCP URL whenever the owner wants it.
 */
function SignedIn() {
  const auth = useAuth()
  const me = useMe()
  return (
    <Async query={me} rows={2}>
      {(data) => {
        const ready = isSetUp(data)
        return (
          <Shell owner={data.owner} wide={!ready} onSignOut={auth.logout}>
            {ready ? <Routes /> : <OnboardingPage me={data} />}
          </Shell>
        )
      }}
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
