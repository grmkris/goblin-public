import { CircleAlertIcon, CircleStopIcon } from 'lucide-react'
import { Reasoning, ReasoningContent, ReasoningTrigger, Receipt } from '@purrable/ui'
import type { Part, ToolPart } from '../../lib/parts.ts'
import { McpToolPart } from './mcp-tool-part.tsx'
import { AssistantText, UserText } from './text-part.tsx'
import { GenericToolPart } from './tool-part.tsx'

/** The renderer for a tool part: MCP calls get the server-aware card (and its App), the agent's own tools the generic one. */
function ToolView({ part }: { readonly part: ToolPart }) {
  return part.target ? <McpToolPart part={part} /> : <GenericToolPart part={part} />
}

/** One transcript part. `canSwitchModel`: another model is on offer, so a provider failure can point at the picker. */
export function PartView({ part, canSwitchModel }: { readonly part: Part; readonly canSwitchModel: boolean }) {
  switch (part.kind) {
    case 'user':
      return <UserText text={part.text} />
    case 'text':
      return <AssistantText text={part.text} />
    case 'reasoning':
      return (
        <Reasoning>
          <ReasoningTrigger live={part.live}>{part.live ? 'Thinking…' : 'Thoughts'}</ReasoningTrigger>
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      )
    case 'tool':
      return <ToolView part={part} />
    case 'failure':
      return (
        <Receipt tone={part.failure.stopped ? 'neutral' : 'error'}>
          {part.failure.stopped ? <CircleStopIcon aria-hidden /> : <CircleAlertIcon aria-hidden />}
          <span>
            {part.failure.text}{' '}
            {part.failure.provider &&
              (canSwitchModel ? 'Try again later, or pick another model below.' : 'Try again later.')}
          </span>
        </Receipt>
      )
  }
}
