import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { AgentAppChange, AgentAppDetail, AgentAppJob, AppPower } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from '@goblin/ui'
import { changeAgentApp, deleteAgentApp, readAgentApp } from '../lib/agent-apps.ts'
import { jobLine } from '../lib/app-jobs.ts'
import { failureText } from '../lib/boundary.ts'
import { PageSection } from './page-section.tsx'
import { powerText } from './parts/app-powers.tsx'
import { AppTile } from './sidebar-tree.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

type Run = (change: AgentAppChange) => Promise<void>

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const kib = (bytes: number) => `${String(Math.max(0, Math.round(bytes / 1024)))} KB`

/** One agent app, read and changed: every change answers with the app as it is after it. */
function useAgentApp(name: string) {
  const [app, setApp] = useState<AgentAppDetail>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const feed = useWorkspaceFeed()
  const shown = feed.apps.find((each) => each.source.kind === 'agent' && each.source.name === name)
  const revision = shown?.source.kind === 'agent' ? `${shown.source.revision}:${JSON.stringify(shown.source.jobs)}` : ''
  useEffect(() => {
    let live = true
    readAgentApp(name)
      .then((detail) => {
        if (live) setApp(detail)
      })
      .catch((cause: unknown) => {
        if (live) setError(failureText(cause))
      })
    return () => {
      live = false
    }
  }, [name, revision])
  const run = useCallback<Run>(
    async (change) => {
      setBusy(true)
      setError('')
      try {
        setApp(await changeAgentApp(name, change))
      } catch (cause) {
        setError(failureText(cause))
      } finally {
        setBusy(false)
      }
    },
    [name],
  )
  return { app, error, busy, run }
}

/** The app's words, its version, where it lives (which the owner may change) and the way to open it. */
function Overview({ app, busy, run }: { readonly app: AgentAppDetail; readonly busy: boolean; readonly run: Run }) {
  const feed = useWorkspaceFeed()
  const homes = feed.conversations.filter((each) => each.kind !== 'subagent' && each.closedBy === undefined)
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <AppTile origin={app.name} />
            <p className="text-sm text-muted-foreground">
              v{app.version} · state r{app.revision} · changed {when(app.updatedAt)}
            </p>
            {app.app !== null && (
              <Button size="sm" className="ml-auto" render={<Link to="/a/$appId" params={{ appId: app.app }} />}>
                Open
              </Button>
            )}
          </div>
          <p className="text-sm">{app.description}</p>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Lives in</span>
            <NativeSelect
              value={app.home}
              disabled={busy}
              onChange={(event) => void run({ kind: 'home', conversation: event.target.value })}
            >
              {homes.map((conversation) => (
                <NativeSelectOption key={conversation.id} value={conversation.id}>
                  {conversation.kind === 'main' ? 'Main' : (conversation.title ?? `Thread ${conversation.id}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Link to="/c/$conversationId" params={{ conversationId: app.home }} className="underline">
              Go there
            </Link>
          </label>
        </div>
      </CardContent>
    </Card>
  )
}

function JobRow({ job, busy, run }: { readonly job: AgentAppJob; readonly busy: boolean; readonly run: Run }) {
  const paused = job.paused !== null
  return (
    <li className="apps-row">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{jobLine(job, Date.now())}</p>
        {job.lastAt !== null && (
          <p className="text-xs text-muted-foreground">
            Last run {when(job.lastAt)}: {job.status ?? 'none'}
            {job.error === null ? '' : ` · ${job.error}`}
          </p>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void run({ kind: 'pause', action: job.action, paused: !paused })}
      >
        {paused ? 'Resume' : 'Pause'}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run({ kind: 'run', action: job.action })}>
        Run now
      </Button>
    </li>
  )
}

function PowerRow({ power, busy, run }: { readonly power: AppPower; readonly busy: boolean; readonly run: Run }) {
  const allowed = power.status === 'approved'
  return (
    <li className="apps-row">
      <span className="min-w-0 flex-1 text-sm">{powerText(power)}</span>
      <Badge variant={allowed ? 'secondary' : 'outline'}>{allowed ? 'Allowed' : power.status}</Badge>
      <Button
        size="sm"
        variant={allowed ? 'outline' : 'default'}
        disabled={busy}
        onClick={() => void run({ kind: 'power', power: power.kind, target: power.target, allowed: !allowed })}
      >
        {allowed ? 'Revoke' : 'Allow'}
      </Button>
    </li>
  )
}

/** Its versions, newest first: a retired one can come back (its state too, when it no longer fits). */
function Versions({ app, busy, run }: { readonly app: AgentAppDetail; readonly busy: boolean; readonly run: Run }) {
  return (
    <ul className="apps-list">
      {app.releases.map((release) => (
        <li key={release.release} className="apps-row">
          <span className="min-w-0 flex-1 text-sm">
            v{release.version} · {when(release.at)}
            {release.note === null ? '' : ` · ${release.note}`}
          </span>
          <Badge variant={release.status === 'failed' ? 'destructive' : 'outline'}>{release.status}</Badge>
          {release.status === 'retired' && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ kind: 'rollback', release: release.release })}
            >
              Go back
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Deleting erases the app for good; the owner types its name first. */
function DeleteApp({ app }: { readonly app: AgentAppDetail }) {
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  async function remove(): Promise<void> {
    try {
      await deleteAgentApp(app.name, typed)
      await navigate({ to: '/apps' })
    } catch (cause) {
      setError(failureText(cause))
    }
  }
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Deleting erases its state, files, schedules and versions, and your agent loses its tools. Type{' '}
            <strong>{app.name}</strong> to delete it.
          </p>
          <div className="flex gap-2">
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} aria-label="App name" />
            <Button variant="destructive" disabled={typed !== app.name} onClick={() => void remove()}>
              Delete
            </Button>
          </div>
          {error !== '' && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

/** Today's use, its files, and what happened lately. */
function Activity({ app }: { readonly app: AgentAppDetail }) {
  const { usage, files } = app
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Today: {usage.job} scheduled runs · {usage.egress} fetches · {usage.tokens} model tokens · {usage.notify}{' '}
        messages. Files: {files.count} ({kib(files.bytes)}).
      </p>
      <ul className="apps-list">
        {app.events.map((event, index) => (
          <li key={`${String(event.at)}-${String(index)}`} className="apps-event" data-kind={event.kind}>
            <span className="text-xs text-muted-foreground">{when(event.at)}</span>
            <span className="text-sm">{event.detail}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * One agent app's page (ADR 0021): open it, see where it lives and move it, pause, resume or run its schedules, allow
 * or revoke its powers, go back to an earlier version, see its use and activity, and delete it.
 */
export function AppManage({ name }: { readonly name: string }) {
  const { app, error, busy, run } = useAgentApp(name)
  if (app === undefined)
    return error === '' ? (
      <Skeleton className="h-40 w-full" />
    ) : (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  return (
    <div className="apps-page">
      {error !== '' && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Overview app={app} busy={busy} run={run} />
      {app.jobs.length > 0 && (
        <PageSection id="app-schedules" title="Schedules" count={app.jobs.length}>
          <ul className="apps-list">
            {app.jobs.map((job) => (
              <JobRow key={job.action} job={job} busy={busy} run={run} />
            ))}
          </ul>
        </PageSection>
      )}
      {app.powers.length > 0 && (
        <PageSection id="app-powers" title="Powers" note="What it reaches beyond its own state and files.">
          <ul className="apps-list">
            {app.powers.map((power) => (
              <PowerRow key={`${power.kind} ${power.target}`} power={power} busy={busy} run={run} />
            ))}
          </ul>
        </PageSection>
      )}
      <PageSection id="app-versions" title="Versions" count={app.releases.length}>
        <Versions app={app} busy={busy} run={run} />
      </PageSection>
      <PageSection id="app-activity" title="Activity">
        <Activity app={app} />
      </PageSection>
      <PageSection id="app-delete" title="Delete">
        <DeleteApp app={app} />
      </PageSection>
    </div>
  )
}
