import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { KeyRoundIcon, MessageCircleQuestionIcon, PlugIcon, PowerIcon } from 'lucide-react'
import { PRIMARY_CHAT, type ToolView } from '@goblin/contracts'
import {
  AskCard,
  AskCardActions,
  AskCardDescription,
  AskCardHeader,
  Badge,
  Button,
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  Receipt,
} from '@goblin/ui'
import { capabilitiesQuery, setCapabilityMutation } from '../capabilities/queries.ts'
import { toolGrantMutation, toolsQuery } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { targetLabel } from '../lib/capabilities.ts'
import { answerText, type Interaction, interactionOperation } from '../lib/interactions.ts'
import { reportUnexpected } from '../lib/unexpected.ts'
import { addAndConnect } from './server-add.tsx'
import { ApprovalCard } from './approval-card.tsx'

/** Sends the owner's reply as their next message, under the interaction's stable operation id. */
type Answer = (input: string, operationId: string) => Promise<boolean>
type Question = Extract<Interaction, { kind: 'question' }>
type Grant = Extract<Interaction, { kind: 'grant' }>
type Capability = Extract<Interaction, { kind: 'capability' }>

/** The server's own description and hints for a tool, shown as its claims; nothing while they cannot be read. */
function useToolClaims(serverId: string, name: string): ToolView | undefined {
  return useQuery(toolsQuery(serverId)).data?.find((item) => item.name === name)
}

/** A card's reply in flight: its buttons wait while it is sent, and a failure is shown on the card. */
function useReplying() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function replying(send: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await send()
    } catch (cause) {
      setError(messageOf(cause, 'send your answer'))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, replying }
}

/** A card's failure, then its two answers: Not now, and the one that lets the agent go on. */
function CardReplies({
  busy,
  error,
  yes,
  onReply,
}: {
  readonly busy: boolean
  readonly error: string
  readonly yes: string
  readonly onReply: (yes: boolean) => void
}) {
  return (
    <>
      {error && <Receipt tone="error">{error}</Receipt>}
      <AskCardActions>
        <Button variant="ghost" disabled={busy} onClick={() => onReply(false)}>
          Not now
        </Button>
        <Button disabled={busy} onClick={() => onReply(true)}>
          {yes}
        </Button>
      </AskCardActions>
    </>
  )
}

type ServerRequest = Extract<Interaction, { kind: 'server' }>

/**
 * A server the agent asks the owner to add (ADR 0021): its name, address and the agent's reason. Adding it uses the
 * usual flow (its sign-in, then the tools they allow); the agent adds nothing itself.
 */
function ServerRequestCard({
  interaction,
  onAnswer,
}: {
  readonly interaction: ServerRequest
  readonly onAnswer: Answer
}) {
  const { endpoint, name, reason } = interaction
  const { busy, error, replying } = useReplying()
  const reply = (yes: boolean) =>
    void replying(async () => {
      await onAnswer(
        yes ? `Adding ${name} (${endpoint}); I will choose its tools. Continue once it is connected.` : 'Not now.',
        interactionOperation(interaction),
      )
      if (yes) await addAndConnect(endpoint, name)
    })
  return (
    <AskCard aria-label="Server request">
      <AskCardHeader>
        <PlugIcon aria-hidden />
        <p>
          Your agent asks you to add <strong className="font-medium">{name}</strong>
        </p>
      </AskCardHeader>
      <AskCardDescription className="break-all">{endpoint}</AskCardDescription>
      <AskCardDescription>Its reason: {reason}</AskCardDescription>
      <CardReplies busy={busy} error={error} yes="Add and connect" onReply={reply} />
    </AskCard>
  )
}

/** Permission for one exact tool. Allowing it stays allowed until the owner turns it off under Connections. */
function GrantCard({ interaction, onAnswer }: { readonly interaction: Grant; readonly onAnswer: Answer }) {
  const { serverId, name } = interaction
  const tool = useToolClaims(serverId, name)
  const { busy, error, replying } = useReplying()
  const grant = useMutation(toolGrantMutation).mutateAsync
  const reply = (allowed: boolean) =>
    void replying(async () => {
      if (allowed) await grant({ serverId, name, allowed })
      await onAnswer(
        allowed ? `Allowed ${serverId} · ${name}. Continue.` : 'Not allowed.',
        interactionOperation(interaction),
      )
    })
  return (
    <AskCard aria-label="Permission request">
      <AskCardHeader>
        <KeyRoundIcon aria-hidden />
        <p>
          Your agent wants to use{' '}
          <strong className="font-medium">
            {serverId} · {name}
          </strong>
        </p>
      </AskCardHeader>
      {tool?.description && (
        <AskCardDescription>
          {serverId} describes it as: {tool.description}
        </AskCardDescription>
      )}
      {(tool?.readOnlyHint === true || tool?.destructiveHint === true) && (
        <div className="flex flex-wrap gap-1.5">
          {tool.readOnlyHint === true && <Badge variant="outline">says read-only</Badge>}
          {tool.destructiveHint === true && <Badge variant="destructive">says destructive</Badge>}
        </div>
      )}
      <AskCardDescription>Allowing it keeps it allowed until you turn it off under Connections.</AskCardDescription>
      <CardReplies busy={busy} error={error} yes="Allow" onReply={reply} />
    </AskCard>
  )
}

/**
 * Something switched off in this conversation that the agent tried to use. Turning it on changes this conversation
 * only (never a grant), then tells the agent to continue.
 */
function CapabilityCard({
  interaction,
  thread,
  onAnswer,
}: {
  readonly interaction: Capability
  readonly thread: string
  readonly onAnswer: Answer
}) {
  const { target } = interaction
  const view = useQuery(capabilitiesQuery(thread)).data
  const label = targetLabel(target, view)
  const where = thread === PRIMARY_CHAT ? 'in main' : 'in this thread'
  const { busy, error, replying } = useReplying()
  const turnOn = useMutation(setCapabilityMutation(thread)).mutateAsync
  const reply = (on: boolean) =>
    void replying(async () => {
      if (on) await turnOn({ target, on })
      await onAnswer(on ? `Turned on ${label} here. Continue.` : 'Not now.', interactionOperation(interaction))
    })
  return (
    <AskCard aria-label="Switched off here">
      <AskCardHeader>
        <PowerIcon aria-hidden />
        <p>
          Your agent wants to use <strong className="font-medium">{label}</strong>
        </p>
      </AskCardHeader>
      <AskCardDescription>
        It is switched off {where}. Turning it on here changes only this conversation.
      </AskCardDescription>
      <CardReplies busy={busy} error={error} yes="Turn on here" onReply={reply} />
    </AskCard>
  )
}

/**
 * The agent's questions, one at a time with number shortcuts; the answers go back as one message, once: Send turns
 * busy until they are on their way, like every other card's replies.
 */
function QuestionCard({ interaction, onAnswer }: { readonly interaction: Question; readonly onAnswer: Answer }) {
  const { questions } = interaction
  const several = questions.length > 1
  const { busy, error, replying } = useReplying()
  return (
    <AskCard aria-label="Questions from your agent">
      <AskCardHeader>
        <MessageCircleQuestionIcon aria-hidden />
        <p>Your agent asks</p>
      </AskCardHeader>
      <Questionnaire
        shortcuts="numbers"
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          const data = new FormData(event.currentTarget)
          replying(() =>
            onAnswer(
              answerText(questions, (id) => data.getAll(id)),
              interactionOperation(interaction),
            ),
          ).catch(reportUnexpected)
        }}
      >
        {several && <QuestionnaireProgress />}
        {questions.map((question) => (
          <QuestionnaireItem key={question.id} name={question.id} multiple={question.kind === 'multi'}>
            <QuestionnaireTitle>{question.prompt}</QuestionnaireTitle>
            {question.kind !== 'text' && (
              <QuestionnaireChoices>
                {(question.options ?? []).map((option) => (
                  <QuestionnaireChoice key={option.id} value={option.id}>
                    {option.label}
                    {option.description && (
                      <QuestionnaireChoiceDescription>{option.description}</QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
            )}
            {(question.kind === 'text' || question.allowOther === true) && (
              <QuestionnaireInput placeholder={question.kind === 'text' ? 'Your answer' : 'Something else'} />
            )}
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          {several && <QuestionnairePrevious />}
          {several && <QuestionnaireNext />}
          <QuestionnaireSubmit disabled={busy}>Send answers</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
      {error && <Receipt tone="error">{error}</Receipt>}
    </AskCard>
  )
}

/** What the agent is waiting on in `thread`, pinned above the composer until the owner replies. */
export function InteractionCards({
  interactions,
  thread,
  onAnswer,
}: {
  readonly interactions: readonly Interaction[]
  readonly thread: string
  readonly onAnswer: Answer
}) {
  return interactions.map((interaction) => {
    if (interaction.kind === 'approval') return <ApprovalCard key={interaction.callId} interaction={interaction} />
    if (interaction.kind === 'grant')
      return <GrantCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    if (interaction.kind === 'capability')
      return <CapabilityCard key={interaction.callId} interaction={interaction} thread={thread} onAnswer={onAnswer} />
    if (interaction.kind === 'server')
      return <ServerRequestCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    return <QuestionCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
  })
}
