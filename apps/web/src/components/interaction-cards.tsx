import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { KeyRoundIcon, MessageCircleQuestionIcon, PlugIcon, Settings2Icon } from 'lucide-react'
import { type ServerView, type ToolView, itemLabel } from '@goblin/contracts'
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
import { serversQuery, toolGrantMutation, toolsQuery } from '../mcp/queries.ts'
import { useAddAndConnect, useConnectionLabels } from '../mcp/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { answerText, type Interaction, interactionOperation } from '../lib/interactions.ts'
import { setWorkspaceTopicSetupMutation } from '../lib/workspace/mutations.ts'
import { ApprovalCard } from './approval-card.tsx'

/** Sends the owner's reply as their next message, under the interaction's stable operation id. */
export type Answer = (input: string, operationId: string) => Promise<boolean>
type Question = Extract<Interaction, { kind: 'question' }>
type Grant = Extract<Interaction, { kind: 'grant' }>
type Setup = Extract<Interaction, { kind: 'setup' }>

/** The server's own description and hints for a tool, shown as its claims; nothing while they cannot be read. */
function useToolClaims(connectionId: string, name: string): ToolView | undefined {
  return useQuery(toolsQuery(connectionId)).data?.find((item) => item.name === name)
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

/** Whether two endpoints are the same address, as the runtime stores them (a parsed URL), or exactly as written. */
const sameEndpoint = (stored: string, asked: string): boolean => {
  try {
    return new URL(asked).href === stored
  } catch {
    // expected: an address the parser refuses is compared as written
    return asked === stored
  }
}

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
  const addAndConnect = useAddAndConnect()
  const mine = (useQuery(serversQuery).data ?? []).filter((server) => sameEndpoint(server.endpoint, endpoint))
  const reply = (yes: boolean) =>
    void replying(async () => {
      await onAnswer(
        yes ? `Adding ${name} (${endpoint}); I will choose its tools. Continue once it is connected.` : 'Not now.',
        interactionOperation(interaction),
      )
      if (yes) await addAndConnect(endpoint, name)
    })
  const use = (connection: ServerView) =>
    void replying(() =>
      onAnswer(
        `Use ${connection.label} (${connection.connectionId}), which is already connected to that server.`,
        interactionOperation(interaction),
      ),
    )
  const [first] = mine
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
      {first === undefined ? (
        <CardReplies busy={busy} error={error} yes="Add and connect" onReply={reply} />
      ) : (
        <>
          <AskCardDescription>
            You already have it: {mine.map((server) => server.label).join(', ')}. Use that, or add another connection to
            sign in as another account.
          </AskCardDescription>
          {error && <Receipt tone="error">{error}</Receipt>}
          <AskCardActions>
            <Button variant="ghost" disabled={busy} onClick={() => reply(false)}>
              Not now
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => reply(true)}>
              Add another connection
            </Button>
            <Button disabled={busy} onClick={() => use(first)}>
              Use {first.label}
            </Button>
          </AskCardActions>
        </>
      )}
    </AskCard>
  )
}

/**
 * Permission for one exact tool. Allowing it stays allowed until the owner turns it off under Connections. `who` is
 * the agent that asked: Goblin, or a Persona by name (ADR 0041).
 */
export function GrantCard({
  interaction,
  onAnswer,
  who = 'Your agent',
}: {
  readonly interaction: Grant
  readonly onAnswer: Answer
  readonly who?: string
}) {
  const { connectionId, name } = interaction
  const tool = useToolClaims(connectionId, name)
  const connection = useConnectionLabels()(connectionId)
  const { busy, error, replying } = useReplying()
  const grant = useMutation(toolGrantMutation).mutateAsync
  const reply = (allowed: boolean) =>
    void replying(async () => {
      if (allowed) await grant({ connectionId, name, allowed })
      await onAnswer(
        allowed ? `Allowed ${connectionId} · ${name}. Continue.` : 'Not allowed.',
        interactionOperation(interaction),
      )
    })
  return (
    <AskCard aria-label="Permission request">
      <AskCardHeader>
        <KeyRoundIcon aria-hidden />
        <p>
          {who} wants to use{' '}
          <strong className="font-medium">
            {connection} · {name}
          </strong>
        </p>
      </AskCardHeader>
      {tool?.description && (
        <AskCardDescription>
          {connection} describes it as: {tool.description}
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
 * Something the chat's Topic's setup does not hold that the agent tried to use (ADR 0040). Adding it changes what every
 * chat of the Topic works with, never a grant (a tool still needs the owner's grant), then tells the agent to continue.
 */
function AddToTopicCard({ interaction, onAnswer }: { readonly interaction: Setup; readonly onAnswer: Answer }) {
  const { target, topic } = interaction
  const label = itemLabel(target)
  const { busy, error, replying } = useReplying()
  const add = useMutation(setWorkspaceTopicSetupMutation).mutateAsync
  const reply = (yes: boolean) =>
    void replying(async () => {
      if (yes) await add({ id: topic.id, edit: { add: [target] } })
      await onAnswer(
        yes ? `Added ${label} to #${topic.name}. Continue.` : 'Not now.',
        interactionOperation(interaction),
      )
    })
  return (
    <AskCard aria-label="Not in this Topic">
      <AskCardHeader>
        <Settings2Icon aria-hidden />
        <p>
          Your agent wants to use <strong className="font-medium">{label}</strong>
        </p>
      </AskCardHeader>
      <AskCardDescription>
        It is not in #{topic.name}'s MCP servers & skills. Adding it changes what every chat of #{topic.name} works
        with.
      </AskCardDescription>
      <CardReplies busy={busy} error={error} yes={`Add to #${topic.name}`} onReply={reply} />
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
  const answer = (data: FormData) =>
    void replying(() =>
      onAnswer(
        answerText(questions, (id) => data.getAll(id)),
        interactionOperation(interaction),
      ),
    )
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
          answer(new FormData(event.currentTarget))
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
    if (interaction.kind === 'server')
      return <ServerRequestCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    if (interaction.kind === 'setup')
      return <AddToTopicCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
    return <QuestionCard key={interaction.callId} interaction={interaction} onAnswer={onAnswer} />
  })
}
