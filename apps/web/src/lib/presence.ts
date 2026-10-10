import type { StreamStatus } from './conversation-stream.ts'
import type { Part } from './parts.ts'
import { queuedProgress, type ConversationProjection } from './projection.ts'

/** What the agent is doing, as the presence orb and its label show it. */
export type Presence =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'waiting'
  | 'retrying'
  | 'error'
  | 'offline'
  | 'exhausted'

export type PresenceView = { readonly state: Presence; readonly label: string }

export type PresenceInput = {
  readonly status: StreamStatus
  readonly projection: ConversationProjection | undefined
  readonly parts: readonly Part[]
  /** Questions or permission requests open for the owner. */
  readonly waiting: number
  /** Today's model budget is spent. */
  readonly exhausted: boolean
}

/** The running tool's name as the owner knows it: `server · tool` for an MCP call. */
function runningTool(parts: readonly Part[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.kind === 'tool' && part.state === 'running')
      return part.target ? `${part.target.serverId} · ${part.target.name}` : part.call.name
  }
  return undefined
}

function runningPresence(projection: ConversationProjection, parts: readonly Part[]): PresenceView {
  const tool = runningTool(parts)
  if (tool !== undefined) return { state: 'tool', label: `Using ${tool}` }
  if (projection.partial !== '') return { state: 'responding', label: 'Writing…' }
  return { state: 'thinking', label: 'Thinking…' }
}

/**
 * One state for the whole agent, most urgent first: a lost connection, then the owner being needed, then the run's
 * own progress, then how the last turn ended.
 */
export function presenceOf({ status, projection, parts, waiting, exhausted }: PresenceInput): PresenceView {
  if (status !== 'connected')
    return { state: 'offline', label: status === 'connecting' ? 'Connecting…' : 'Reconnecting…' }
  if (projection === undefined) return { state: 'offline', label: 'Connecting…' }
  if (waiting > 0) return { state: 'waiting', label: 'Waiting for you' }
  if (projection.progress === 'Waiting for model retry') return { state: 'retrying', label: 'Retrying the model…' }
  // A message just sent shows its working row before the run has started.
  if (projection.running || parts.at(-1)?.kind === 'working') return runningPresence(projection, parts)
  if (exhausted) return { state: 'exhausted', label: "Today's budget is spent" }
  const last = parts.at(-1)
  if (last?.kind === 'failure' && last.failure.cutOff === true) return { state: 'error', label: 'Cut off' }
  if (last?.kind === 'failure' && last.failure.stopped !== true) return { state: 'error', label: 'No answer' }
  if (projection.inbox.length > 0) return { state: 'waiting', label: queuedProgress(projection.inbox.length) }
  return { state: 'idle', label: 'Ready' }
}
