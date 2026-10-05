import type { ReactNode } from 'react'
import { CircleAlertIcon, CircleStopIcon, KeyRoundIcon, MessageCircleQuestionIcon } from 'lucide-react'
import { Reasoning, ReasoningContent, ReasoningTrigger, Receipt } from '@purrable/ui'
import { type Interaction, interactionOf } from '../../lib/interactions.ts'
import type { Part, ToolPart } from '../../lib/parts.ts'
import { ThreadStartedRow } from '../thread-replies.tsx'
import { McpToolPart } from './mcp-tool-part.tsx'
import { AssistantText, UserText } from './text-part.tsx'
import { GenericToolPart, SubagentToolPart } from './tool-part.tsx'

/** Quiet lines (receipts, thinking) start where the assistant's text does, inside its bubble's padding. */
function Aside({ children }: { readonly children: ReactNode }) {
  return <div className="px-3.5">{children}</div>
}

/** Where the agent asked the owner something: a quiet line here; the open request itself sits above the composer. */
function InteractionReceipt({ interaction }: { readonly interaction: Interaction }) {
  return (
    <Aside>
      {interaction.kind === 'grant' ? (
        <Receipt>
          <KeyRoundIcon aria-hidden />
          <span>
            Asked to use {interaction.serverId} · {interaction.name}
          </span>
        </Receipt>
      ) : (
        <Receipt>
          <MessageCircleQuestionIcon aria-hidden />
          <span>Asked you: {interaction.questions.map((question) => question.prompt).join(' · ')}</span>
        </Receipt>
      )}
    </Aside>
  )
}

/**
 * The renderer for a tool part: a question or permission request becomes its receipt, MCP calls get the
 * server-aware card (and its App), a subagent call links to the subagent, the agent's other tools the generic one.
 */
function ToolView({ part }: { readonly part: ToolPart }) {
  const interaction = interactionOf(part)
  if (interaction !== undefined) return <InteractionReceipt interaction={interaction} />
  if (part.target) return <McpToolPart part={part} />
  return part.call.name === 'subagent' ? <SubagentToolPart part={part} /> : <GenericToolPart part={part} />
}

/** One transcript part. `canSwitchModel`: another model is on offer, so a provider failure can point at the picker. */
export function PartView({ part, canSwitchModel }: { readonly part: Part; readonly canSwitchModel: boolean }) {
  switch (part.kind) {
    case 'user':
      return <UserText text={part.text} context={part.context ?? []} author={part.author} thread={part.thread} />
    case 'text':
      return <AssistantText text={part.text} />
    case 'reasoning':
      return (
        <Aside>
          <Reasoning>
            <ReasoningTrigger live={part.live}>{part.live ? 'Thinking…' : 'Thoughts'}</ReasoningTrigger>
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>
        </Aside>
      )
    case 'tool':
      return <ToolView part={part} />
    case 'thread-started':
      return <ThreadStartedRow thread={part.thread} />
    case 'failure':
      return (
        <Aside>
          <Receipt tone={part.failure.stopped ? 'neutral' : 'error'}>
            {part.failure.stopped ? <CircleStopIcon aria-hidden /> : <CircleAlertIcon aria-hidden />}
            <span>
              {part.failure.text}{' '}
              {part.failure.provider &&
                (canSwitchModel ? 'Try again later, or pick another model below.' : 'Try again later.')}
            </span>
          </Receipt>
        </Aside>
      )
  }
}
