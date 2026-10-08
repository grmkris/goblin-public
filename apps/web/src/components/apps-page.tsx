import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { AgentAppSummary } from '@goblin/contracts'
import { Alert, AlertDescription, Badge, Card, CardDescription, CardHeader, CardTitle, Skeleton } from '@goblin/ui'
import { listAgentApps } from '../lib/agent-apps.ts'
import { jobLine, jobTrouble } from '../lib/app-jobs.ts'
import { failureText } from '../lib/boundary.ts'
import { AppTile } from './sidebar-tree.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** What an app needs from the owner, if anything: powers to allow, a schedule in trouble, a failure. */
function needs(app: AgentAppSummary): string | undefined {
  if (app.waiting > 0) return `${String(app.waiting)} to allow`
  if (app.jobs.some(jobTrouble)) return 'Schedule needs you'
  return app.failure === null ? undefined : 'Failing'
}

function AppCard({ app }: { readonly app: AgentAppSummary }) {
  const [job] = app.jobs
  const need = needs(app)
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
            {job === undefined ? '' : ` · ${jobLine(job, Date.now())}`}
          </p>
        </CardHeader>
      </Card>
    </Link>
  )
}

/**
 * The owner's agent apps (ADR 0021): every app their agent built, those without a view too, newest change first, each
 * opening its own page. The list reloads when the feed shows an app change.
 */
export function AppsPage() {
  const feed = useWorkspaceFeed()
  const [apps, setApps] = useState<readonly AgentAppSummary[]>()
  const [error, setError] = useState('')
  const changed = feed.apps
    .filter((app) => app.source.kind === 'agent')
    .map((app) => `${app.id}:${app.source.kind === 'agent' ? app.source.revision : ''}`)
    .join(',')
  useEffect(() => {
    let live = true
    listAgentApps()
      .then((list) => {
        if (live) setApps(list)
      })
      .catch((cause: unknown) => {
        if (live) setError(failureText(cause))
      })
    return () => {
      live = false
    }
  }, [changed])
  return (
    <div className="apps-page">
      <p className="section-note">
        Apps your agent built for you. Ask for one in any conversation: “make me a tracker for …”.
      </p>
      {error !== '' && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {apps === undefined && error === '' && <Skeleton className="h-24 w-full" />}
      {apps?.length === 0 && <p className="text-sm text-muted-foreground">No apps yet.</p>}
      <div className="apps-grid">
        {apps?.map((app) => (
          <AppCard key={app.name} app={app} />
        ))}
      </div>
    </div>
  )
}
