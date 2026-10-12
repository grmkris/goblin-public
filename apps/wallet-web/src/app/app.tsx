import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@goblin/ui'
import { useConnections, useMe } from '../api/queries.tsx'
import { ActivityPage } from '../pages/activity.tsx'
import { HomePage } from '../pages/home.tsx'
import { OnboardingPage, readSkipped } from '../pages/onboarding.tsx'
import { setupProgress } from '../pages/progress.ts'
import { SignInPage } from '../pages/sign-in.tsx'
import { Async, LoadingBlock } from '../ui/async.tsx'
import { useAuth } from './auth.tsx'
import { useLocation } from './router.tsx'
import { Shell } from './shell.tsx'

function Soon({ name }: { readonly name: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{name}</EmptyTitle>
        <EmptyDescription>This page is being built.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function Routes() {
  const { pathname } = useLocation()
  if (pathname === '/activity') return <ActivityPage />
  if (pathname === '/limits') return <Soon name="Limits" />
  if (pathname === '/connections') return <Soon name="Connections" />
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
          ) : setupProgress(data, (connections.data?.length ?? 0) > 0, readSkipped()) === 'done' ? (
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
  if (auth.status !== 'ready') return <SignInPage />
  return <SignedIn />
}
