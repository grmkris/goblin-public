import { useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { RoutineRunPage, type RoutineRunView } from '@purrable/contracts'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Button } from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'

/** Pi acceptance and Telegram acceptance are shown separately from the run's outcome. */
export function RoutineHistory({
  id,
  revision,
  active,
}: {
  readonly id: string
  readonly revision: number
  readonly active: boolean
}) {
  const [runs, setRuns] = useState<readonly RoutineRunView[]>([])
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const load = useCallback(() => {
    void request(`/api/routines/${id}/runs`)
      .then((value) => setRuns(Schema.decodeUnknownSync(RoutineRunPage)(value).runs))
      .catch((cause: unknown) => setError(failureText(cause)))
  }, [id])
  useEffect(load, [load])
  async function command(run?: RoutineRunView) {
    setPending(true)
    setError('')
    try {
      if (run?.sessionId) await request(`/api/conversations/${run.sessionId}/stop`, { body: {} })
      else
        await request(`/api/routines/${id}/run`, {
          headers: { 'x-purrable-csrf': '1' },
          body: { revision, operationId: crypto.randomUUID(), confirmRun: true },
        })
      load()
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {active && (
          <Button size="sm" disabled={pending} onClick={() => void command()}>
            Run now
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={load}>
          Refresh runs
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {runs.map((run) => (
        <div key={run.id} className="flex flex-col gap-1 border-t pt-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {run.state} · {new Date(run.firedAt).toLocaleString()}
            </span>
            {run.sessionId && (
              <Link className="underline" to="/t/$threadId" params={{ threadId: run.sessionId }}>
                Open run
              </Link>
            )}
            {run.sessionId && ['admitted', 'running', 'waiting_owner'].includes(run.state) && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void command(run)}>
                Stop
              </Button>
            )}
          </div>
          <p>{run.summary ?? run.outcome}</p>
          <p className="text-muted-foreground">
            Main note: {run.reportAcceptedAt ? 'accepted' : 'pending'} · Telegram report: {run.notificationState}
          </p>
        </div>
      ))}
    </div>
  )
}
