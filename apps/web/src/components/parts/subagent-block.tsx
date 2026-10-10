import { type ReactNode, use, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ConversationView, UpdateConversation } from '@goblin/contracts'
import { Button, Duration } from '@goblin/ui'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  Columns2Icon,
  PinIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react'
import { stopMutation } from '../../conversations/queries.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { type SubagentState, isBusy, subagentLabel, subagentState, workingUnder } from '../../lib/subagent-state.ts'
import { subagentAction, subagentOf, threadTitle } from '../../lib/threads.ts'
import { useActivities, useActivity, useConversation, useConversations } from '../../lib/workspace/hooks.ts'
import { updateWorkspaceConversationMutation } from '../../lib/workspace/mutations.ts'
import { useNow } from '../use-now.ts'
import { OpenThread } from './text-part.tsx'
import { ToolCard } from './tool-part.tsx'

/** A subagent's state as a small mark: a turning ring at work, a check once it reported, a square once stopped. */
export function SubagentStateIcon({ state }: { readonly state: SubagentState }) {
  let icon = null
  if (state.kind === 'reported' || (state.kind === 'closed' && state.by === 'done')) icon = <CheckIcon />
  else if (state.kind === 'stopped') icon = <SquareIcon />
  else if (state.kind === 'closed') icon = <XIcon />
  else if (state.kind === 'idle') icon = <CircleIcon />
  return (
    <span className="state-icon" data-state={state.kind} aria-hidden>
      {icon}
    </span>
  )
}

/** The state in words, with a running clock while it works. */
export function SubagentStateText({ state }: { readonly state: SubagentState }) {
  const now = useNow(state.kind === 'working' || state.kind === 'reported')
  if (state.kind === 'working')
    return (
      <>
        working <Duration ms={now - state.since} running />
      </>
    )
  return <>{subagentLabel(state, Math.floor(now / 1000))}</>
}

/**
 * A subagent's live state and what the owner can do to it: Stop (the subagent and all under it, the call the pane's
 * Stop makes), Keep open past its report, Close and Reopen. A Stop the feed cannot show is remembered here until the
 * subagent works again.
 */
export function useSubagent(view: ConversationView) {
  const conversations = useConversations()
  const stopping = useMutation(stopMutation).mutate
  const updating = useMutation(updateWorkspaceConversationMutation).mutate
  const [failure, setFailure] = useState('')
  const activity = useActivity(view.id)
  // Stopped, until the subagent's activity moves on: what it was doing when the owner stopped it.
  const [stoppedDuring, setStoppedDuring] = useState<{ readonly activity: typeof activity }>()
  const stopped = stoppedDuring !== undefined && (activity === undefined || activity === stoppedDuring.activity)
  // A change the server refuses shows in the feed's status, beside the composer, as every conversation change does.
  const act = (change: UpdateConversation) => {
    setFailure('')
    updating({ id: view.id, change })
  }
  const state = subagentState(view, activity, stopped)
  const below = workingUnder(view.id, conversations, useActivities())
  return {
    state,
    below,
    busy: isBusy(state, below),
    failure,
    parent: threadTitle(useConversation(view.parent)),
    children: conversations.filter((candidate) => candidate.kind === 'subagent' && candidate.parent === view.id),
    stop: () => {
      setFailure('')
      stopping(view.id, {
        onSuccess: () => setStoppedDuring({ activity }),
        onError: (cause) => setFailure(messageOf(cause, 'stop the subagent')),
      })
    },
    keepOpen: () => act({ keepOpen: true }),
    dismiss: () => act({ closed: true }),
    reopen: () => act({ closed: false }),
  }
}

type Subagent = ReturnType<typeof useSubagent>

/** Stop asks first: the subagent and everything working under it stop, and all of it stays readable. */
function StopConfirm({
  name,
  below,
  onStop,
  onCancel,
}: {
  readonly name: string
  readonly below: number
  readonly onStop: () => void
  readonly onCancel: () => void
}) {
  return (
    <div className="work-confirm" role="alertdialog" aria-label={`Stop ${name}?`}>
      <span>
        Stop {name}
        {below > 0 && ` and the ${below} working under it`}? Everything stays readable.
      </span>
      <Button size="sm" variant="destructive" onClick={onStop}>
        Stop
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

function Tool({
  label,
  onClick,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  )
}

/** The row's tools, shown on hover: open it beside, Stop while anything works, Keep open, Close or Reopen. */
function SubagentTools({
  view,
  name,
  subagent,
  onOpen,
  onStop,
}: {
  readonly view: ConversationView
  readonly name: string
  readonly subagent: Subagent
  readonly onOpen: () => void
  readonly onStop: () => void
}) {
  const closed = subagent.state.kind === 'closed'
  return (
    <span className="work-tools">
      <Tool label={`Open ${name} beside`} onClick={onOpen}>
        <Columns2Icon aria-hidden />
      </Tool>
      {subagent.busy && !closed && (
        <Tool label={`Stop ${name}`} onClick={onStop}>
          <SquareIcon aria-hidden />
        </Tool>
      )}
      {!closed && !view.keepOpen && (
        <Tool label={`Keep ${name} open`} onClick={subagent.keepOpen}>
          <PinIcon aria-hidden />
        </Tool>
      )}
      {closed ? (
        <Tool label={`Reopen ${name}`} onClick={subagent.reopen}>
          <RotateCcwIcon aria-hidden />
        </Tool>
      ) : (
        <Tool label={`Close ${name}`} onClick={subagent.dismiss}>
          <XIcon aria-hidden />
        </Tool>
      )}
    </span>
  )
}

/** What a subagent row's details say about where it stands. */
function noteOf(view: ConversationView, { state, below, parent }: Subagent): string {
  if (state.kind === 'closed')
    return state.by === 'done' ? 'Closed after its report. Reopen it to write to it.' : 'You closed it.'
  if (below > 0) return `Waiting on ${below} of its subagents.`
  if (state.kind === 'stopped') return 'Stopped. Write to it to start it again.'
  if (view.keepOpen) return 'Kept open: it stays after its report until you close it.'
  if (state.kind === 'reported') return `Its report went to ${parent}.`
  return `Started by ${parent}. It closes after its report unless you keep it open.`
}

/** The opened row: the task it was given, where it stands, and its own subagents, to any depth. */
function SubagentDetail({
  view,
  subagent,
  task,
  label,
}: {
  readonly view: ConversationView
  readonly subagent: Subagent
  readonly task: string | undefined
  readonly label: string
}) {
  return (
    <div className="work-detail">
      {task !== undefined && (
        <p className="work-task">
          <span className="work-label">{label}</span>
          {task}
        </p>
      )}
      <p className="work-note">{noteOf(view, subagent)}</p>
      {subagent.children.length > 0 && (
        <div className="work-children">
          {subagent.children.map((child) => (
            <SubagentRow key={child.id} view={child} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One subagent as a line: its state, its name (which opens it beside), what it is doing, and its tools. The chevron
 * opens its task, a note and its own subagents.
 */
function SubagentRow({
  view,
  task,
  label = 'Task',
}: {
  readonly view: ConversationView
  readonly task?: string
  readonly label?: string
}) {
  const subagent = useSubagent(view)
  const openBeside = use(OpenThread)
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const name = threadTitle(view)
  const open = () => openBeside?.(view.id)
  return (
    <div className="work-row" data-state={subagent.state.kind}>
      <div className="work-line">
        <button
          type="button"
          className="work-toggle"
          aria-expanded={expanded}
          aria-label={`Details for ${name}`}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRightIcon aria-hidden />
        </button>
        <SubagentStateIcon state={subagent.state} />
        <button type="button" className="work-name" onClick={open} title={`Open ${name} beside`}>
          {name}
        </button>
        <span className="work-meta">
          <SubagentStateText state={subagent.state} />
          {subagent.below > 0 && !expanded && <span className="work-below"> · {subagent.below} working under it</span>}
        </span>
        <SubagentTools view={view} name={name} subagent={subagent} onOpen={open} onStop={() => setConfirming(true)} />
      </div>
      {confirming && (
        <StopConfirm
          name={name}
          below={subagent.below}
          onStop={() => {
            setConfirming(false)
            subagent.stop()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
      {subagent.failure !== '' && <p className="work-failure">{subagent.failure}</p>}
      {expanded && <SubagentDetail view={view} subagent={subagent} task={task} label={label} />}
    </div>
  )
}

/**
 * A subagent call that started or wrote to a subagent: the subagent itself, live from the workspace feed. A
 * call still running, one that failed, a stop or a status check stays a plain tool line.
 */
export function SubagentBlock({ part }: { readonly part: ToolPart }) {
  const subagent = subagentOf(part)
  const action = subagentAction(part)
  const { message } = part.call.arguments
  const view = useConversation(subagent?.thread)
  if (view === undefined || (action !== 'spawn' && action !== 'send')) return <ToolCard part={part} />
  return (
    <SubagentRow
      view={view}
      {...(typeof message === 'string' && { task: message })}
      label={action === 'spawn' ? 'Task' : 'Message'}
    />
  )
}
