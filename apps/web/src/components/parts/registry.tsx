import { type ReactNode, memo } from 'react'
import {
  CircleAlertIcon,
  CircleStopIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  PlugIcon,
  PowerIcon,
} from 'lucide-react'
import { Reasoning, ReasoningContent, ReasoningTrigger, Receipt } from '@goblin/ui'
import { targetLabel } from '../../lib/capabilities.ts'
import { type Interaction, interactionOf } from '../../lib/interactions.ts'
import { type Part, type ToolPart, samePart } from '../../lib/parts.ts'
import { subagentAction } from '../../lib/threads.ts'
import { ThreadStartedRow } from '../inline-thread.tsx'
import { HomeReceipt } from '../home/receipt.tsx'
import { AppBuildPart } from './app-build-part.tsx'
import { McpToolPart } from './mcp-tool-part.tsx'
import { AssistantText, UserText } from './text-part.tsx'
import { SubagentBlock } from './subagent-block.tsx'
import { GenericToolPart } from './tool-part.tsx'
import { RoutineProposalPart } from './routine-proposal.tsx'

/** Quiet lines (receipts, thinking) start where the assistant's text does, inside its bubble's padding. */
function Aside({ children }: { readonly children: ReactNode }) {
  return <div className="px-3.5">{children}</div>
}

/** What a receipt says about a request to the owner. */
function InteractionLine({ interaction }: { readonly interaction: Interaction }) {
  if (interaction.kind === 'approval')
    return (
      <Receipt>
        <KeyRoundIcon aria-hidden />
        <span>
          Asked to approve {interaction.serverId} · {interaction.name}
        </span>
      </Receipt>
    )
  if (interaction.kind === 'grant')
    return (
      <Receipt>
        <KeyRoundIcon aria-hidden />
        <span>
          Asked to use {interaction.serverId} · {interaction.name}
        </span>
      </Receipt>
    )
  if (interaction.kind === 'capability')
    return (
      <Receipt>
        <PowerIcon aria-hidden />
        <span>Asked to turn on {targetLabel(interaction.target)} here</span>
      </Receipt>
    )
  if (interaction.kind === 'server')
    return (
      <Receipt>
        <PlugIcon aria-hidden />
        <span>Asked you to add {interaction.name}</span>
      </Receipt>
    )
  return (
    <Receipt>
      <MessageCircleQuestionIcon aria-hidden />
      <span>Asked you: {interaction.questions.map((question) => question.prompt).join(' · ')}</span>
    </Receipt>
  )
}

/** Where the agent asked the owner something: a quiet line here; the open request itself sits above the composer. */
function InteractionReceipt({ interaction }: { readonly interaction: Interaction }) {
  return (
    <Aside>
      <InteractionLine interaction={interaction} />
    </Aside>
  )
}

/**
 * The renderer for a tool part: a question or permission request becomes its receipt, MCP calls get the
 * server-aware card (and its App), an app build its card and the app's view, a subagent call the subagent itself,
 * live, the agent's other tools the generic one.
 */
function ToolView({ part }: { readonly part: ToolPart }) {
  const interaction = interactionOf(part)
  if (interaction !== undefined) return <InteractionReceipt interaction={interaction} />
  if (part.target) return <McpToolPart part={part} />
  if (part.built !== undefined) return <AppBuildPart part={part} />
  if (part.call.name === 'home_edit') return <HomeReceipt part={part} />
  // `routine` is the single tool older transcripts used (ADR 0027).
  if (part.call.name === 'routine_propose' || part.call.name === 'routine') return <RoutineProposalPart part={part} />
  return subagentAction(part) === undefined ? <GenericToolPart part={part} /> : <SubagentBlock part={part} />
}

/**
 * One transcript part. `canSwitchModel`: another model is on offer, so a provider failure can point at the picker.
 * Memoised on what the part draws (`samePart`): a streamed batch rebuilds every part, and only the changed ones render.
 */
export const PartView = memo(
  PartRow,
  (before, after) => before.canSwitchModel === after.canSwitchModel && samePart(before.part, after.part),
)

function PartRow({ part, canSwitchModel }: { readonly part: Part; readonly canSwitchModel: boolean }) {
  switch (part.kind) {
    case 'user':
      return (
        <UserText
          text={part.text}
          context={part.context ?? []}
          attachments={part.attachments ?? []}
          author={part.author}
          thread={part.thread}
          at={part.at}
        />
      )
    case 'text':
      return <AssistantText text={part.text} live={part.live} />
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
