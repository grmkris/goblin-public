import { type ReactNode } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import type { RoutineRunView } from '@goblin/contracts'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Button, Skeleton } from '@goblin/ui'
import { RefreshCwIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary, QueryError } from '../lib/query/query-boundary.tsx'
import { routineRunsQuery, runRoutineMutation, stopRunMutation } from '../routines/queries.ts'
import { runStatus, telegramReport } from '../lib/labels.ts'
import { StatusLabel } from './status-label.tsx'
import { dateTime } from '../lib/format.ts'

const LIVE: readonly RoutineRunView['state'][] = ['admitted', 'running', 'waiting_owner']
const FINISHED: readonly RoutineRunView['state'][] = ['completed', 'failed', 'stopped']

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
          {dateTime(run.firedAt)}
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

/** The runs' heading, with `children` (Run now, Refresh) beside it once the runs are read. */
function RunsHead({ children }: { readonly children?: ReactNode }) {
  return (
    <div className="server-part-head">
      <h3 className="server-part-title">Runs</h3>
      {children}
    </div>
  )
}

type HistoryProps = { readonly id: string; readonly revision: number; readonly active: boolean }

function Runs({ id, revision, active }: HistoryProps) {
  const read = useSuspenseQuery(routineRunsQuery(id))
  const running = useMutation(runRoutineMutation)
  const stopping = useMutation(stopRunMutation)
  const { runs } = read.data
  const pending = running.isPending ? 'run' : stopping.isPending ? stopping.variables.run : undefined
  const error =
    (running.error !== null && messageOf(running.error, 'run it')) ||
    (stopping.error !== null && messageOf(stopping.error, 'stop the run')) ||
    ''
  const runNow = () => running.mutate({ id, revision, operationId: crypto.randomUUID() })
  const stop = (run: string, chat: string) => stopping.mutate({ routineId: id, chat, run })
  const reload = () => void read.refetch()
  return (
    <>
      <RunsHead>
        {active && (
          <Button size="xs" variant="ghost" pending={pending === 'run'} onClick={runNow}>
            Run now
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Refresh runs" pending={read.isFetching} onClick={reload}>
          <RefreshCwIcon />
        </Button>
      </RunsHead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {read.isRefetchError && <QueryError error={read.error} action="list its runs" onRetry={reload} />}
      {runs.length === 0 && <p className="server-note">No runs yet.</p>}
      {runs.length > 0 && (
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
    </>
  )
}

/** A routine's runs: Run now while it is on, then each run with where it stands, what it found and its reports. */
export function RoutineHistory(props: HistoryProps) {
  return (
    <section className="server-part" aria-label="Runs">
      <QueryBoundary
        action="list its runs"
        pending={
          <>
            <RunsHead />
            <Skeleton className="h-6 w-full" />
          </>
        }
      >
        <Runs {...props} />
      </QueryBoundary>
    </section>
  )
}
