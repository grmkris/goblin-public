import { useEffect, useState } from 'react'
import { Option, Schema } from 'effect'
import { KeyRoundIcon, MessageCircleQuestionIcon, PowerIcon } from 'lucide-react'
import { MAIN_THREAD, ToolView } from '@purrable/contracts'
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
} from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { targetLabel } from '../lib/capabilities.ts'
import { answerText, type Interaction, interactionOperation } from '../lib/interactions.ts'
import { useCapabilities } from './capabilities.tsx'

/** Sends the owner's reply as their next message, under the interaction's stable operation id. */
type Answer = (input: string, operationId: string) => Promise<boolean>
type Question = Extract<Interaction, { kind: 'question' }>
type Grant = Extract<Interaction, { kind: 'grant' }>
type Capability = Extract<Interaction, { kind: 'capability' }>

const decodeTools = Schema.decodeUnknownOption(Schema.Array(ToolView))

/** The server's own description and hints for a tool, shown as its claims; nothing when they cannot be read. */
function useToolClaims(serverId: string, name: string): ToolView | undefined {
  const [tool, setTool] = useState<ToolView>()
  useEffect(() => {
    const controller = new AbortController()
    void request(`/api/mcp/${encodeURIComponent(serverId)}/tools`, { signal: controller.signal })
      .then((data) => setTool(Option.getOrUndefined(decodeTools(data))?.find((item) => item.name === name)))
      .catch(() => undefined)
    return () => controller.abort()
  }, [serverId, name])
  return tool
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
      setError(failureText(cause))
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

/** Permission for one exact tool. Allowing it stays allowed until the owner turns it off under Connections. */
function GrantCard({ interaction, onAnswer }: { readonly interaction: Grant; readonly onAnswer: Answer }) {
  const { serverId, name } = interaction
  const tool = useToolClaims(serverId, name)
  const { busy, error, replying } = useReplying()
  const reply = (allowed: boolean) =>
    void replying(async () => {
      if (allowed) await request('/api/mcp/grants', { method: 'PUT', body: { serverId, name, allowed } })
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
  const { view } = useCapabilities(thread, false)
  const label = targetLabel(target, view)
  const where = thread === MAIN_THREAD ? 'in main' : 'in this thread'
  const { busy, error, replying } = useReplying()
  const reply = (on: boolean) =>
    void replying(async () => {
      if (on) await request(`/api/conversations/${thread}/capabilities`, { method: 'PATCH', body: { target, on } })
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

/** The agent's questions, one at a time with number shortcuts; the answers go back as one message. */
function QuestionCard({ interaction, onAnswer }: { readonly interaction: Question; readonly onAnswer: Answer }) {
  const { questions } = interaction
  const several = questions.length > 1
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
          const data = new FormData(event.currentTarget)
          void onAnswer(
            answerText(questions, (id) => data.getAll(id)),
            interactionOperation(interaction),
          )
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
          <QuestionnaireSubmit>Send answers</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
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
    if (interaction.kind === 'grant')
      return <GrantCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    if (interaction.kind === 'capability')
      return <CapabilityCard key={interaction.callId} interaction={interaction} thread={thread} onAnswer={onAnswer} />
    return <QuestionCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
  })
}
