import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { AppManage } from '../components/app-manage.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'

/** One agent app's page (ADR 0021), by its name. */
export const Route = createFileRoute('/apps/$name')({
  beforeLoad: ({ params }) => {
    if (!/^[a-z][a-z0-9-]{1,23}$/u.test(params.name)) throw redirect({ to: '/apps' })
  },
  component: AppRoute,
})
function AppRoute() {
  const { name } = Route.useParams()
  return (
    <OwnerGate>
      <PageBar
        title={
          <>
            <Link to="/apps" className="text-muted-foreground hover:text-foreground">
              Apps
            </Link>{' '}
            / {name}
          </>
        }
      />
      <div className="shell">
        <AppManage name={name} />
      </div>
    </OwnerGate>
  )
}
