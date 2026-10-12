import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@goblin/ui'
import { useMe } from '../api/queries.tsx'
import { ActivityPage } from '../pages/activity.tsx'
import { HomePage } from '../pages/home.tsx'
import { Async } from '../ui/async.tsx'
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

/** The signed-in app: the shell around whichever page the location names. */
export function App({ onSignOut }: { readonly onSignOut: () => void }) {
  const me = useMe()
  return (
    <Async query={me} rows={2}>
      {(data) => (
        <Shell owner={data.owner} onSignOut={onSignOut}>
          <Routes />
        </Shell>
      )}
    </Async>
  )
}
