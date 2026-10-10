// A routine's card: what it does and when, its facts, and the owner's Confirm, Pause, Edit and Archive, with its runs.
import { useMutation } from '@tanstack/react-query'
import type { RoutineDefinition, RoutineView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@goblin/ui'
import { dateTime } from '../lib/format.ts'
import { routineStatus } from '../lib/labels.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { changeRoutineMutation } from '../routines/queries.ts'
import { RoutineHistory } from './routine-history.tsx'
import { StatusLabel } from './status-label.tsx'

const operation = () => crypto.randomUUID()
const count = (value: number) => value.toLocaleString()

/** When a routine runs, in words. */
function whenOf(definition: RoutineDefinition): string {
  const trigger = definition.trigger
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at)
    return Number.isNaN(at) ? `Once, at ${trigger.at}` : `Once, ${dateTime(at, definition.timezone)}`
  }
  if (trigger.kind === 'cron') return `Repeats on the schedule ${trigger.expression}`
  return `When ${trigger.serverId} sends ${trigger.name}`
}

/** What a routine does and may use, as facts beside each other. */
function RoutineDetails({ routine }: { readonly routine: RoutineView }) {
  const { definition } = routine
  const { budget, trigger } = definition
  return (
    <>
      <p className="routine-prompt">{definition.prompt}</p>
      <dl className="routine-facts">
        {routine.nextFireAt !== null && trigger.kind !== 'once' && (
          <div>
            <dt>Next</dt>
            <dd>{dateTime(routine.nextFireAt, definition.timezone)}</dd>
          </div>
        )}
        {trigger.kind === 'event' && (
          <div>
            <dt>Only events matching</dt>
            <dd>
              <code>{JSON.stringify(trigger.arguments)}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Tools</dt>
          <dd>
            {definition.allowedTools.length === 0
              ? 'None: it can only answer'
              : definition.allowedTools.map((tool) => `${tool.serverId} · ${tool.name}`).join(', ')}
          </dd>
        </div>
        {(routine.outsideSetup?.length ?? 0) > 0 && (
          <div>
            <dt>Not in its Topic</dt>
            <dd>
              {routine.outsideSetup?.map((tool) => `${tool.serverId} · ${tool.name}`).join(', ')}: its Topic's MCP
              servers & skills leave these out, so a run that calls one is refused.
            </dd>
          </div>
        )}
        <div>
          <dt>Limits</dt>
          <dd>
            {count(budget.tokensPerRun)} tokens a run, {count(budget.tokensPerDay)} a day,{' '}
            {Math.round(budget.runtimeSeconds / 60)} minutes at most
          </dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd>{definition.notifyTelegram ? 'Sends its report there too' : 'Off'}</dd>
        </div>
      </dl>
      {routine.health !== null && routine.health !== 'execution_pending' && (
        <p className="server-note">{routine.health}</p>
      )}
    </>
  )
}

type Change = 'confirm' | 'pause' | 'archive'

/** Confirm, Pause, Edit and Archive, each busy while it is under way; the routines read again once it lands. */
function useRoutineChange(routine: RoutineView) {
  const changing = useMutation(changeRoutineMutation)
  const pending = changing.isPending ? changing.variables.action : undefined
  const error = changing.error === null ? '' : messageOf(changing.error, 'change this routine')
  const change = (action: Change) =>
    changing.mutate({ action, id: routine.id, revision: routine.revision, operationId: operation() })
  return { pending, error, change }
}

/** Owner review is an authenticated revisioned API operation, never a model tool confirmation. */
export function RoutineReview({ routine, onEdit }: { readonly routine: RoutineView; readonly onEdit?: () => void }) {
  const { pending, error, change } = useRoutineChange(routine)
  const { state, definition } = routine
  const busy = pending !== undefined
  return (
    <Card>
      <CardHeader>
        <CardTitle>{definition.title}</CardTitle>
        <CardDescription>{whenOf(definition)}</CardDescription>
        <CardAction>
          <StatusLabel label={routineStatus(routine)} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <RoutineDetails routine={routine} />
          {state === 'proposed' && <p className="server-note">Nothing runs until you confirm it.</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="card-actions">
            {(state === 'proposed' || state === 'paused') && (
              <Button size="sm" pending={pending === 'confirm'} disabled={busy} onClick={() => change('confirm')}>
                {state === 'paused' ? 'Resume' : 'Confirm'}
              </Button>
            )}
            {(state === 'active' || state === 'activating') && (
              <Button
                size="sm"
                variant="outline"
                pending={pending === 'pause'}
                disabled={busy}
                onClick={() => change('pause')}
              >
                Pause
              </Button>
            )}
            {onEdit && (
              <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              pending={pending === 'archive'}
              disabled={busy}
              onClick={() => change('archive')}
            >
              Archive
            </Button>
          </div>
          <RoutineHistory id={routine.id} revision={routine.revision} active={state === 'active'} />
        </div>
      </CardContent>
    </Card>
  )
}
