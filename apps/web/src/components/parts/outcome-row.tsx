import type { McpOutcome } from '@goblin/contracts'
import { CircleAlertIcon, CircleCheckIcon, CircleSlashIcon } from 'lucide-react'
import {
  JsonView,
  Receipt,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  type ToolCallState,
  ToolCallTitle,
  ToolCallTrigger,
  ToolPayload,
} from '@goblin/ui'
import { useConnectionLabels } from '../../mcp/hooks.ts'

type Continuation = McpOutcome['continuation']

/** The line's dot: it ran, it was stopped on purpose (cancelled, refused, run out of time), or it went wrong. */
const STATE: Record<Continuation['state'], ToolCallState> = {
  completed: 'done',
  declined: 'stopped',
  refused: 'stopped',
  expired: 'stopped',
  failed: 'error',
  uncertain: 'error',
}

/** What happened, in words: the owner's decision or step, and what became of the call. */
function sentence({ kind, name, state }: Continuation, connection: string): string {
  if (state === 'uncertain') return `${name} on ${connection} may have run. Check there before trying again.`
  if (kind === 'url') {
    if (state === 'completed') return `You finished the step ${connection} asked for, and ${name} went on`
    if (state === 'expired') return `The step ${connection} asked for ran out of time; ${name} did not run`
    if (state === 'failed') return `${name} on ${connection} could not be sent again`
    return `You cancelled the step ${connection} asked for; ${name} did not run`
  }
  if (state === 'completed') return `You approved ${name} on ${connection}, and it ran`
  if (state === 'expired') return `Your approval of ${name} on ${connection} ran out of time; it did not run`
  if (state === 'failed') return `${name} on ${connection} was not sent`
  return `You refused ${name} on ${connection}`
}

/**
 * How a call held for the owner ended (ADR 0028, ADR 0042): one quiet line in the transcript where the turn goes on,
 * never the owner's own message. It opens to the server's answer, shown as its data.
 */
export function OutcomeRow({ outcome }: { readonly outcome: McpOutcome }) {
  const labels = useConnectionLabels()
  const { continuation, result } = outcome
  const connection = labels(continuation.connectionId)
  const text = sentence(continuation, connection)
  const state = STATE[continuation.state]
  if (result === undefined)
    return (
      <div className="px-3.5">
        <Receipt tone={state === 'error' ? 'error' : 'neutral'}>
          {state === 'done' ? (
            <CircleCheckIcon aria-hidden />
          ) : state === 'error' ? (
            <CircleAlertIcon aria-hidden />
          ) : (
            <CircleSlashIcon aria-hidden />
          )}
          <span>{text}</span>
        </Receipt>
      </div>
    )
  return (
    <ToolCall>
      <ToolCallTrigger>
        <ToolCallStatus state={state} />
        <ToolCallTitle>{text}</ToolCallTitle>
      </ToolCallTrigger>
      <ToolCallContent>
        <ToolPayload label={`${connection}’s answer`} raw={JSON.stringify(result, undefined, 2)} view="tree">
          <JsonView value={result} />
        </ToolPayload>
      </ToolCallContent>
    </ToolCall>
  )
}
