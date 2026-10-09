import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { type PersonaInvocationView, RoutinePage, type RoutineView } from '@goblin/contracts'
import { Schema } from 'effect'
import { RepeatIcon } from 'lucide-react'
import { request } from '../../../lib/boundary.ts'
import { delegates, personaTasks } from '../../../lib/rail.ts'
import { subagentState } from '../../../lib/subagent-state.ts'
import { relativeTime, threadTitle } from '../../../lib/threads.ts'
import { PageSection } from '../../page-section.tsx'
import { SubagentStateIcon, SubagentStateText } from '../../parts/subagent-block.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'
import { useMinute } from '../../use-now.ts'
import { useWorkspaceFeed } from '../../workspace-feed.tsx'
import { ChatRow, RowContents } from './chat-link.tsx'

const decodeRoutines = Schema.decodeUnknownSync(RoutinePage)
const NEXT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const SCHEDULED: readonly RoutineView['state'][] = ['activating', 'active', 'paused']

/** The routines that run on their own: their names, when each runs next or last ran. Read once the page opens. */
function useRoutines(): readonly RoutineView[] {
  const [routines, setRoutines] = useState<readonly RoutineView[]>([])
  useEffect(() => {
    const controller = new AbortController()
    request('/api/routines', { signal: controller.signal })
      .then((data) => setRoutines(decodeRoutines(data).routines.filter((each) => SCHEDULED.includes(each.state))))
      .catch(() => setRoutines([]))
    return () => controller.abort()
  }, [])
  return routines
}

const STATES: Readonly<Record<PersonaInvocationView['state'], string>> = {
  pending: 'waiting',
  running: 'answering…',
  answered: 'answered',
  failed: 'failed',
  stopped: 'stopped',
}

/** One Delegate (a subagent): its state, its name, who started it and where it stands; it opens in its panel. */
function DelegateRow({ id }: { readonly id: string }) {
  const feed = useWorkspaceFeed()
  const view = feed.conversations.find((candidate) => candidate.id === id)
  if (view === undefined) return null
  const state = subagentState(view, feed.activity.get(view.id))
  const spawner = threadTitle(feed.conversations.find((candidate) => candidate.id === view.parent))
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
  const feed = useWorkspaceFeed()
  const answers = personaTasks(feed.invocations ?? [])
  if (answers.length === 0) return null
  const personas = new Map((feed.personas ?? []).map((persona) => [persona.id, persona]))
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

/** The routines on a schedule: each by its title, when it runs next (or that it is paused); they open in Settings. */
function Routines({ routines }: { readonly routines: readonly RoutineView[] }) {
  if (routines.length === 0) return null
  return (
    <PageSection id="routines" title="Routines">
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
                      : `Next ${NEXT.format(routine.nextFireAt)}`
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
  const feed = useWorkspaceFeed()
  const now = useMinute()
  const work = delegates(feed.conversations, feed.activity)
  const routines = useRoutines()
  const listed = [...work.active, ...work.finished]
  if (listed.length + (feed.invocations ?? []).length + routines.length === 0)
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
      <Routines routines={routines} />
    </div>
  )
}
