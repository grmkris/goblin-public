import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { PersonaInvocationView, RoutineView } from '@goblin/contracts'
import { RepeatIcon } from 'lucide-react'
import { QueryError } from '../../../lib/query/query-boundary.tsx'
import { delegates, personaTasks } from '../../../lib/rail.ts'
import { subagentState } from '../../../lib/subagent-state.ts'
import { threadTitle } from '../../../lib/threads.ts'
import { routinesQuery } from '../../../routines/queries.ts'
import { PageSection } from '../../page-section.tsx'
import { SubagentStateIcon, SubagentStateText } from '../../parts/subagent-block.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'
import {
  useActivities,
  useActivity,
  useConversation,
  useConversations,
  useInvocations,
  usePersonas,
} from '../../../lib/workspace/hooks.ts'
import { useMinute } from '../../use-now.ts'
import { ChatRow, RowContents } from './chat-link.tsx'
import { dateTime, relativeTime } from '../../../lib/format.ts'

const SCHEDULED: readonly RoutineView['state'][] = ['activating', 'active', 'paused']

const STATES: Readonly<Record<PersonaInvocationView['state'], string>> = {
  pending: 'waiting',
  running: 'answering…',
  answered: 'answered',
  failed: 'failed',
  stopped: 'stopped',
}

/** One Delegate (a subagent): its state, its name, who started it and where it stands; it opens in its panel. */
function DelegateRow({ id }: { readonly id: string }) {
  const view = useConversation(id)
  const activity = useActivity(id)
  const spawner = threadTitle(useConversation(view?.parent))
  if (view === undefined) return null
  const state = subagentState(view, activity)
  return (
    <li>
      <ChatRow chat={view.id}>
        <RowContents
          mark={<SubagentStateIcon state={state} />}
          title={threadTitle(view)}
          meta={
            <>
              from {spawner} · <SubagentStateText state={state} />
            </>
          }
        />
      </ChatRow>
    </li>
  )
}

/** The Personas answering, then those that answered: each with its mark, what it is doing, and the chat it is in. */
function PersonaAnswers({ now }: { readonly now: number }) {
  const answers = personaTasks(useInvocations())
  const all = usePersonas()
  if (answers.length === 0) return null
  const personas = new Map(all.map((persona) => [persona.id, persona]))
  return (
    <PageSection id="personas" title="Personas">
      <ul className="list-rows">
        {answers.map((invocation) => {
          const persona = personas.get(invocation.persona)
          return (
            <li key={`${invocation.operationId}:${invocation.persona}`}>
              <ChatRow chat={invocation.chat}>
                <RowContents
                  mark={persona === undefined ? null : <PersonaAvatar avatar={persona.avatar} size="sm" />}
                  title={persona?.name ?? 'A persona'}
                  meta={`${STATES[invocation.state]} · ${relativeTime(invocation.settledAt ?? invocation.createdAt, now)}`}
                />
              </ChatRow>
            </li>
          )
        })}
      </ul>
    </PageSection>
  )
}

/**
 * The routines on a schedule: each by its title, when it runs next (or that it is paused); they open in Settings. Their
 * home is Settings, so here they are an optional section: a failed read shows in their place, with a retry, so it never
 * passes for having none.
 */
function Routines({
  routines,
  error,
  retry,
}: {
  readonly routines: readonly RoutineView[]
  readonly error: unknown
  readonly retry: () => void
}) {
  if (routines.length === 0 && error === null) return null
  return (
    <PageSection id="routines" title="Routines">
      {error !== null && <QueryError error={error} action="read your routines" onRetry={retry} />}
      <ul className="list-rows">
        {routines.map((routine) => (
          <li key={routine.id}>
            <Link to="/settings" hash="routines" className="list-row">
              <RowContents
                mark={<RepeatIcon aria-hidden />}
                title={routine.definition.title}
                meta={
                  routine.state === 'paused'
                    ? 'Paused'
                    : routine.nextFireAt === null
                      ? 'Not scheduled'
                      : `Next ${dateTime(routine.nextFireAt)}`
                }
              />
            </Link>
          </li>
        ))}
      </ul>
    </PageSection>
  )
}

/** `/tasks`, delegated work (spec §5): the Delegates, the Personas answering, and the routines on their schedules. */
export function TasksPage() {
  const invocations = useInvocations()
  const now = useMinute()
  const work = delegates(useConversations(), useActivities())
  const read = useQuery(routinesQuery)
  const routines = (read.data?.routines ?? []).filter((each) => SCHEDULED.includes(each.state))
  const listed = [...work.active, ...work.finished]
  if (listed.length + invocations.length + routines.length === 0 && read.error === null)
    return <p className="page-empty">No delegated work.</p>
  return (
    <div className="page-stack">
      {listed.length > 0 && (
        <PageSection id="delegates" title="Delegates">
          <ul className="list-rows">
            {listed.map((view) => (
              <DelegateRow key={view.id} id={view.id} />
            ))}
          </ul>
        </PageSection>
      )}
      <PersonaAnswers now={now} />
      <Routines routines={routines} error={read.error} retry={() => void read.refetch()} />
    </div>
  )
}
