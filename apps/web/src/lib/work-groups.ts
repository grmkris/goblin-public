// A turn's quiet work (its thinking and tool calls) folded to one line that opens to it, so a nine-step turn is one row
// above its answer instead of fourteen. What the owner must see or act on stays where it is: a request to them, a call that
// failed or was blocked, a subagent started or messaged, an App build, a routine to confirm, what a search found, an App
// a call opened. A subagent's status check or stop is quiet work, as its plain line (`SubagentBlock`) says.
import { interactionOf } from './interactions.ts'
import { type Named, type Part, type ToolPart, type WorkStep, partKey } from './parts.ts'
import { sourcesOf } from './sources.ts'
import { subagentAction } from './threads.ts'

/** What the fold needs from outside the parts: which calls have an open App in this conversation. */
export type WorkKeep = { readonly appCalls: ReadonlySet<string> }

/** Fewer steps than this stay as they are: one line is already as short as its summary. */
const MIN_STEPS = 2

/** Whether a tool call must stay in the main flow, because the owner needs to see or act on it. */
function stays(part: ToolPart, keep: WorkKeep): boolean {
  const subagent = subagentAction(part)
  return (
    part.state === 'error' ||
    interactionOf(part) !== undefined ||
    part.built !== undefined ||
    subagent === 'spawn' ||
    subagent === 'send' ||
    part.call.name === 'routine_propose' ||
    part.call.name === 'routine' ||
    (part.call.name === 'search_chats' && sourcesOf(part.result?.details).length > 0) ||
    (part.state === 'done' && keep.appCalls.has(part.call.id))
  )
}

function foldable(part: Part, keep: WorkKeep): part is WorkStep {
  if (part.kind === 'reasoning' || part.kind === 'working') return true
  return part.kind === 'tool' && !stays(part, keep)
}

const underway = (step: WorkStep): boolean =>
  step.kind === 'working' ||
  (step.kind === 'reasoning' && step.live) ||
  (step.kind === 'tool' && (step.state === 'running' || step.state === 'pending'))

/**
 * `parts` with each run of two or more folded steps replaced by one `work` part. A run keeps its place and its order:
 * text, the owner's messages and everything that stays split runs, so a turn that narrates between tool rounds has a
 * line per round. Its key is the part before it, so it does not remount as steps join it.
 */
export function groupWork(parts: readonly Part[], keep: WorkKeep): Part[] {
  const grouped: Part[] = []
  let run: WorkStep[] = []
  let before: Part | undefined
  const flush = () => {
    if (run.length >= MIN_STEPS) {
      const key = `work:${before === undefined ? 'start' : partKey(before)}`
      grouped.push({ kind: 'work', id: key, key, steps: run, live: run.some(underway) })
    } else grouped.push(...run)
    run = []
  }
  for (const part of parts) {
    if (foldable(part, keep)) run.push(part)
    else {
      flush()
      grouped.push(part)
      before = part
    }
  }
  flush()
  return grouped
}

/** Consecutive tool calls to one server, which the open group shows as one line; any other step is a line of its own. */
export type StepLine =
  | { readonly kind: 'step'; readonly step: WorkStep }
  | { readonly kind: 'server'; readonly server: string; readonly calls: readonly ToolPart[] }

const serverOf = (step: WorkStep): string | undefined => (step.kind === 'tool' ? step.target?.connectionId : undefined)

/** The open group's lines: two or more calls in a row to one MCP server merge, with their order kept. */
export function stepLines(steps: readonly WorkStep[]): StepLine[] {
  const lines: StepLine[] = []
  for (const step of steps) {
    const server = serverOf(step)
    const last = lines.at(-1)
    if (server !== undefined && step.kind === 'tool' && last?.kind === 'server' && last.server === server)
      lines[lines.length - 1] = { ...last, calls: [...last.calls, step] }
    else if (server !== undefined && step.kind === 'tool') lines.push({ kind: 'server', server, calls: [step] })
    else lines.push({ kind: 'step', step })
  }
  // One call to a server is just that step.
  return lines.map((line) =>
    line.kind === 'server' && line.calls.length === 1 && line.calls[0] !== undefined
      ? { kind: 'step', step: line.calls[0] }
      : line,
  )
}

/**
 * What the folded line says while it is under way: the tool that is running, or how many are when several run at once
 * (parallel calls start together), else that the model is thinking. A call asked for and not yet started is not running.
 */
export function liveLabel(steps: readonly WorkStep[], named: Named = (connectionId) => connectionId): string {
  const going = steps.filter((step): step is ToolPart => step.kind === 'tool' && step.state === 'running')
  const [only] = going
  if (only === undefined) return 'Thinking…'
  if (going.length === 1)
    return only.target
      ? `Using ${named(only.target.connectionId)} · ${only.target.name}`
      : `Using ${only.call.name || 'a tool'}`
  const servers = new Set(going.map((step) => step.target?.connectionId))
  const [server] = servers
  return servers.size === 1 && server !== undefined
    ? `Using ${named(server)} · ${going.length} tools`
    : `Using ${going.length} tools`
}

/** How many tool calls a group holds, which is what its settled line counts as steps. */
export const stepCount = (steps: readonly WorkStep[]): number => steps.filter((step) => step.kind === 'tool').length
