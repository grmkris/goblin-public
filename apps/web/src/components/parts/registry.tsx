import { type ReactNode, memo, useMemo } from 'react'
import {
  CircleAlertIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  PlugIcon,
  Settings2Icon,
} from 'lucide-react'
import { itemLabel } from '@goblin/contracts'
import {
  Duration,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  Receipt,
  ToolCall,
  ToolCallContent,
  ToolCallMeta,
  ToolCallStatus,
  ToolCallTitle,
  ToolCallTrigger,
} from '@goblin/ui'
import { type Interaction, interactionOf } from '../../lib/interactions.ts'
import { type Part, type ToolPart, partKey, samePart } from '../../lib/parts.ts'
import { subagentAction } from '../../lib/threads.ts'
import { liveLabel, stepCount, stepLines } from '../../lib/work-groups.ts'
import { ThreadStartedRow } from '../shell/thread-summary.tsx'
import { useNow } from '../use-now.ts'
import { AppBuildPart } from './app-build-part.tsx'
import {
  DelegateResultPart,
  NoticePart,
  PersonaAnswerPart,
  PersonaAskPart,
  ThreadHeadPart,
  TopicSeedPart,
} from './drawn-parts.tsx'
import { McpToolPart } from './mcp-tool-part.tsx'
import { AssistantText, UserText } from './text-part.tsx'
import { SubagentBlock } from './subagent-block.tsx'
import { GenericToolPart } from './tool-part.tsx'
import { RoutineProposalPart } from './routine-proposal.tsx'
import { SourcesStrip } from './sources-strip.tsx'
import { sourcesOf } from '../../lib/sources.ts'

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
          Asked to approve {interaction.connectionId} · {interaction.name}
        </span>
      </Receipt>
    )
  if (interaction.kind === 'grant')
    return (
      <Receipt>
        <KeyRoundIcon aria-hidden />
        <span>
          Asked to use {interaction.connectionId} · {interaction.name}
        </span>
      </Receipt>
    )
  if (interaction.kind === 'url')
    return (
      <Receipt>
        <ExternalLinkIcon aria-hidden />
        <span>
          Asked you to finish a step on {interaction.connectionId}’s site for {interaction.name}
        </span>
      </Receipt>
    )
  if (interaction.kind === 'access')
    return (
      <Receipt>
        <KeyRoundIcon aria-hidden />
        <span>Asked you to sign in to {interaction.connectionId} again with more access</span>
      </Receipt>
    )
  if (interaction.kind === 'server')
    return (
      <Receipt>
        <PlugIcon aria-hidden />
        <span>Asked you to add {interaction.name}</span>
      </Receipt>
    )
  if (interaction.kind === 'setup')
    return (
      <Receipt>
        <Settings2Icon aria-hidden />
        <span>
          Asked to add {itemLabel(interaction.target)} to #{interaction.topic.name}
        </span>
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
  // `routine` is the single tool older transcripts used (ADR 0027).
  if (part.call.name === 'routine_propose' || part.call.name === 'routine') return <RoutineProposalPart part={part} />
  // What a search of the owner's other chats found: a source strip, not a tool card.
  const sources = part.call.name === 'search_chats' ? sourcesOf(part.result?.details) : []
  if (sources.length > 0)
    return (
      <Aside>
        <SourcesStrip sources={sources} searched />
      </Aside>
    )
  return subagentAction(part) === undefined ? <GenericToolPart part={part} /> : <SubagentBlock part={part} />
}

const running = (tool: ToolPart): boolean => tool.state === 'running' || tool.state === 'pending'

/** From the first call's start to the last one's end (to now while any runs); undefined when no call has a start. */
function span(tools: readonly ToolPart[], live: boolean, now: number): number | undefined {
  const starts = tools.flatMap((tool) => (tool.startedAt === undefined ? [] : [tool.startedAt]))
  if (starts.length === 0) return undefined
  const ends = tools.flatMap((tool) => (tool.endedAt === undefined ? [] : [tool.endedAt]))
  const end = live ? now : ends.length > 0 ? Math.max(...ends) : undefined
  return end === undefined ? undefined : Math.max(0, end - Math.min(...starts))
}

/** A run of calls to one MCP server, as one line that opens to each of them. */
function ServerLine({
  server,
  calls,
  canSwitchModel,
}: {
  readonly server: string
  readonly calls: readonly ToolPart[]
  readonly canSwitchModel: boolean
}) {
  const live = calls.some(running)
  const elapsed = span(calls, live, useNow(live))
  const state = live ? 'running' : calls.some((call) => call.state === 'stopped') ? 'stopped' : 'done'
  return (
    <ToolCall>
      <ToolCallTrigger>
        <ToolCallStatus state={state} />
        <ToolCallTitle>
          Used <b className="font-medium text-foreground">{server}</b> · {calls.length} calls
        </ToolCallTitle>
        <ToolCallMeta>{elapsed !== undefined && <Duration ms={elapsed} running={live} />}</ToolCallMeta>
      </ToolCallTrigger>
      <ToolCallContent>
        {calls.map((call) => (
          <PartView key={partKey(call)} part={call} canSwitchModel={canSwitchModel} />
        ))}
      </ToolCallContent>
    </ToolCall>
  )
}

/**
 * A turn's quiet work folded to one line: while it runs, the step it is on and a clock; settled, how many steps and how
 * long. It opens to the rows it holds (`lib/work-groups.ts`), with calls in a row to one server merged.
 */
function WorkGroup({
  part,
  canSwitchModel,
}: {
  readonly part: Extract<Part, { readonly kind: 'work' }>
  readonly canSwitchModel: boolean
}) {
  const shown = useMemo(() => part.steps.filter((step) => step.kind !== 'working'), [part.steps])
  const lines = useMemo(() => stepLines(shown), [shown])
  const tools = shown.filter((step): step is ToolPart => step.kind === 'tool')
  const elapsed = span(tools, part.live, useNow(part.live))
  const steps = stepCount(shown)
  const state = part.live ? 'running' : tools.some((tool) => tool.state === 'stopped') ? 'stopped' : 'done'
  return (
    <ToolCall>
      <ToolCallTrigger>
        <ToolCallStatus state={state} />
        <ToolCallTitle>
          {part.live ? liveLabel(part.steps) : steps === 0 ? 'Thoughts' : `${steps} ${steps === 1 ? 'step' : 'steps'}`}
        </ToolCallTitle>
        <ToolCallMeta>{elapsed !== undefined && <Duration ms={elapsed} running={part.live} />}</ToolCallMeta>
      </ToolCallTrigger>
      <ToolCallContent>
        {lines.map((line) =>
          line.kind === 'server' ? (
            <ServerLine
              key={`server:${line.calls[0]?.id ?? line.server}`}
              server={line.server}
              calls={line.calls}
              canSwitchModel={canSwitchModel}
            />
          ) : (
            <PartView key={partKey(line.step)} part={line.step} canSwitchModel={canSwitchModel} />
          ),
        )}
      </ToolCallContent>
    </ToolCall>
  )
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
          selections={part.selections ?? []}
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
    case 'work':
      return <WorkGroup part={part} canSwitchModel={canSwitchModel} />
    case 'working':
      // The live Thoughts row's own size and pulse, so the thinking that follows replaces it without a shift.
      return (
        <Aside>
          <div className="inline-flex min-h-8 w-fit animate-pulse items-center px-1 text-sm text-muted-foreground pointer-coarse:min-h-11">
            Thinking…
          </div>
        </Aside>
      )
    case 'tool':
      return <ToolView part={part} />
    case 'thread-started':
      return <ThreadStartedRow thread={part.thread} />
    case 'thread-head':
      return <ThreadHeadPart part={part} />
    case 'persona-ask':
      return <PersonaAskPart part={part} />
    case 'persona-answer':
      return <PersonaAnswerPart part={part} />
    case 'topic-seed':
      return <TopicSeedPart part={part} />
    case 'delegate-result':
      return <DelegateResultPart part={part} />
    case 'notice':
      return <NoticePart part={part} />
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
