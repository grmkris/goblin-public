import { useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { AgentAppSummary } from '@goblin/contracts'
import { Badge, Card, CardDescription, CardHeader, CardTitle, Skeleton } from '@goblin/ui'
import { agentAppsQuery } from '../agent-apps/queries.ts'
import { jobLine, jobTrouble } from '../lib/app-jobs.ts'
import { QueryBoundary, QueryError } from '../lib/query/query-boundary.tsx'
import { reportUnexpected } from '../lib/unexpected.ts'
import { AppTile } from './apps/app-tile.tsx'
import { useMinute } from './use-now.ts'

/** What an app needs from the owner, if anything: powers to allow, a schedule in trouble, a failure. */
function needs(app: AgentAppSummary): string | undefined {
  if (app.waiting > 0) return `${String(app.waiting)} to allow`
  if (app.jobs.some(jobTrouble)) return 'Schedule needs you'
  return app.failure === null ? undefined : 'Failing'
}

function AppCard({ app }: { readonly app: AgentAppSummary }) {
  const [job] = app.jobs
  const need = needs(app)
  const now = useMinute() * 1000
  return (
    <Link to="/apps/$name" params={{ name: app.name }} className="apps-card">
      <Card interactive>
        <CardHeader>
          <CardTitle>
            <span className="flex items-center gap-2">
              <AppTile origin={app.name} />
              <span className="truncate">{app.title}</span>
              {need !== undefined && (
                <span className="ml-auto">
                  <Badge variant="destructive">{need}</Badge>
                </span>
              )}
            </span>
          </CardTitle>
          <CardDescription>
            <span className="line-clamp-2">{app.description}</span>
          </CardDescription>
          <p className="text-xs text-muted-foreground">
            v{app.version}
            {app.app === null ? ' · no view' : ''}
            {job === undefined ? '' : ` · ${jobLine(job, now)}`}
          </p>
        </CardHeader>
      </Card>
    </Link>
  )
}

/**
 * The list itself, read through the cache the route primed; it reads again when the feed shows an app change
 * (`lib/workspace/invalidations.ts`).
 */
function AppsList() {
  const list = useSuspenseQuery(agentAppsQuery)
  return (
    <>
      {list.isRefetchError && (
        <QueryError
          error={list.error}
          action="load your apps"
          onRetry={() => {
            list.refetch().catch(reportUnexpected)
          }}
        />
      )}
      {list.data.length === 0 && <p className="text-sm text-muted-foreground">No apps yet.</p>}
      <div className="apps-grid">
        {list.data.map((app) => (
          <AppCard key={app.name} app={app} />
        ))}
      </div>
    </>
  )
}

/**
 * The owner's agent apps (ADR 0021): every app their agent built, those without a view too, newest change first, each
 * opening its own page.
 */
export function AppsPage() {
  return (
    <div className="apps-page">
      <p className="section-note">
        Apps your agent built for you. Ask for one in any conversation: “make me a tracker for …”.
      </p>
      <QueryBoundary action="load your apps" pending={<Skeleton className="h-24 w-full" />}>
        <AppsList />
      </QueryBoundary>
    </div>
  )
}
