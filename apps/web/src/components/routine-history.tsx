import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RoutineRunView } from '@goblin/contracts'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Button, Skeleton } from '@goblin/ui'
import { RefreshCwIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import { routineRunsQuery, runRoutineMutation, stopRunMutation } from '../routines/queries.ts'
import { runStatus, telegramReport } from '../lib/labels.ts'
import { StatusLabel } from './status-label.tsx'

const LIVE: readonly RoutineRunView['state'][] = ['admitted', 'running', 'waiting_owner']
const FINISHED: readonly RoutineRunView['state'][] = ['completed', 'failed', 'stopped']
const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Whether a finished run's report reached its channel, and Telegram when it was asked to. */
function reportsOf(run: RoutineRunView): string | undefined {
  if (!FINISHED.includes(run.state)) return undefined
  const main = run.reportAcceptedAt === null ? 'Report pending' : 'Reported'
  const telegram = telegramReport(run.notificationState)
  return telegram === undefined ? main : `${main} · ${telegram}`
}

function RunRow({
  run,
  pending,
  onStop,
}: {
  readonly run: RoutineRunView
  readonly pending: boolean
  readonly onStop: () => void
}) {
  const summary = run.summary ?? run.outcome
  const reports = reportsOf(run)
  return (
    <li className="run-row">
      <div className="run-line">
        <StatusLabel label={runStatus(run.state)} />
        <time className="run-time" dateTime={new Date(run.firedAt).toISOString()}>
          {when(run.firedAt)}
        </time>
        {run.sessionId && (
          <Link className="run-link" to="/c/$chatId" params={{ chatId: run.sessionId }}>
            Open
          </Link>
        )}
        {run.sessionId && LIVE.includes(run.state) && (
          <Button size="xs" variant="outline" pending={pending} onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
      {summary && <p className="run-summary">{summary}</p>}
      {reports && <p className="server-note">{reports}</p>}
    </li>
  )
}

/** A routine's runs: Run now while it is on, then each run with where it stands, what it found and its reports. */
export function RoutineHistory({
  id,
  revision,
  active,
}: {
  readonly id: string
  readonly revision: number
  readonly active: boolean
}) {
  const queryClient = useQueryClient()
  const read = useQuery(routineRunsQuery(id))
  const running = useMutation(runRoutineMutation(queryClient))
  const stopping = useMutation(stopRunMutation(queryClient))
  const runs = read.data?.runs
  const pending = running.isPending ? 'run' : stopping.isPending ? stopping.variables.run : undefined
  const error =
    (running.error !== null && messageOf(running.error, 'run it')) ||
    (stopping.error !== null && messageOf(stopping.error, 'stop the run')) ||
    ''
  const runNow = () => running.mutate({ id, revision, operationId: crypto.randomUUID() })
  const stop = (run: string, chat: string) => stopping.mutate({ routineId: id, chat, run })
  const reload = () => void read.refetch()
  return (
    <section className="server-part" aria-label="Runs">
      <div className="server-part-head">
        <h3 className="server-part-title">Runs</h3>
        {active && (
          <Button size="xs" variant="ghost" pending={pending === 'run'} onClick={runNow}>
            Run now
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Refresh runs" pending={read.isFetching} onClick={reload}>
          <RefreshCwIcon />
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {read.error !== null && <QueryError error={read.error} action="list its runs" onRetry={reload} />}
      {runs === undefined && read.error === null && <Skeleton className="h-6 w-full" />}
      {runs?.length === 0 && <p className="server-note">No runs yet.</p>}
      {runs !== undefined && runs.length > 0 && (
        <ul className="grant-list">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              pending={pending === run.id}
              onStop={() => run.sessionId && stop(run.id, run.sessionId)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
