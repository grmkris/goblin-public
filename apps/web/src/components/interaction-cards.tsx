import { useEffect, useState } from 'react'
import { Option, Schema } from 'effect'
import { KeyRoundIcon, MessageCircleQuestionIcon } from 'lucide-react'
import { ToolView } from '@purrable/contracts'
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
import { answerText, type Interaction, interactionOperation } from '../lib/interactions.ts'

/** Sends the owner's reply as their next message, under the interaction's stable operation id. */
type Answer = (input: string, operationId: string) => Promise<boolean>
type Question = Extract<Interaction, { kind: 'question' }>
type Grant = Extract<Interaction, { kind: 'grant' }>

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

/** Permission for one exact tool. Allowing it stays allowed until the owner turns it off under Connections. */
function GrantCard({ interaction, onAnswer }: { readonly interaction: Grant; readonly onAnswer: Answer }) {
  const { serverId, name } = interaction
  const tool = useToolClaims(serverId, name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function reply(allowed: boolean): Promise<void> {
    setBusy(true)
    setError('')
    try {
      if (allowed) await request('/api/mcp/grants', { method: 'PUT', body: { serverId, name, allowed } })
      await onAnswer(
        allowed ? `Allowed ${serverId} · ${name}. Continue.` : 'Not allowed.',
        interactionOperation(interaction),
      )
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setBusy(false)
    }
  }
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
      {error && <Receipt tone="error">{error}</Receipt>}
      <AskCardActions>
        <Button variant="ghost" disabled={busy} onClick={() => void reply(false)}>
          Not now
        </Button>
        <Button disabled={busy} onClick={() => void reply(true)}>
          Allow
        </Button>
      </AskCardActions>
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

/** What the agent is waiting on, pinned above the composer until the owner replies. */
export function InteractionCards({
  interactions,
  onAnswer,
}: {
  readonly interactions: readonly Interaction[]
  readonly onAnswer: Answer
}) {
  return interactions.map((interaction) =>
    interaction.kind === 'grant' ? (
      <GrantCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    ) : (
      <QuestionCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    ),
  )
}
