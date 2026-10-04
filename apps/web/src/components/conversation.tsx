import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Textarea,
} from '@purrable/ui'
import { isString, request, text } from '../lib/boundary.ts'
import { BrowserPiEvents, ConversationStream } from '../lib/conversation-stream.ts'
import type { ConversationProjection } from '../lib/projection.ts'

function useConversation() {
  const [projection, setProjection] = useState<ConversationProjection>()
  const [connection, setConnection] = useState('Connecting')
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [receipt, setReceipt] = useState('')
  const stream = useRef<ConversationStream | undefined>(undefined)
  useEffect(() => {
    const attachment = new ConversationStream(
      {
        snapshot: (signal) => request('/api/agent/snapshot', undefined, signal),
        events: () => new BrowserPiEvents('/api/agent/events'),
      },
      setProjection,
      setConnection,
    )
    stream.current = attachment
    void attachment.reconnect()
    return () => attachment.dispose()
  }, [])
  async function submit(): Promise<void> {
    if (!input.trim() || pending) return
    setPending(true)
    try {
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- The browser generates a fresh idempotency key for this user submission; no runtime service is available in this client component.
      const operationId = crypto.randomUUID()
      await request('/api/agent', { input: input.trim(), operationId })
      setInput('')
      setReceipt(`Accepted ${operationId}. Completion is shown in committed conversation state.`)
    } catch (error) {
      setReceipt(error instanceof Error ? error.message : 'Submission failed')
    } finally {
      setPending(false)
    }
  }
  async function stop(): Promise<void> {
    try {
      await request('/api/agent/stop', {})
      setReceipt('Stop requested')
    } catch (error) {
      setReceipt(error instanceof Error ? error.message : 'Stop failed')
    }
  }
  return {
    projection,
    connection,
    input,
    setInput,
    pending,
    receipt,
    submit,
    stop,
    reconnect: () => stream.current?.reconnect(),
  }
}
type ConversationView = ReturnType<typeof useConversation>
function ConversationMessages({ projection }: Pick<ConversationView, 'projection'>) {
  return (
    <div className="conversation-log flex flex-col gap-4" aria-live="polite" aria-label="Committed conversation">
      {projection?.messages.messages.length ? (
        projection.messages.messages.map((message) => (
          <article className="message" key={message.id}>
            <Badge variant={message.role === 'user' ? 'outline' : 'secondary'}>{message.role}</Badge>
            <p className="message-text">{text('content' in message ? message.content : '')}</p>
            {message.role === 'assistant' &&
              message.toolCalls?.map((call) => (
                <p className="text-muted-foreground text-sm" key={call.id}>
                  Tool: {call.function.name}
                </p>
              ))}
          </article>
        ))
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Your conversation starts here</EmptyTitle>
            <EmptyDescription>Ask a question or leave a follow-up for the resident agent.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {projection?.partial && (
        <article className="message">
          <Badge variant="secondary">assistant · working</Badge>
          <p className="message-text">{projection.partial}</p>
        </article>
      )}
    </div>
  )
}
function ConversationInput({ view }: { readonly view: ConversationView }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void view.submit()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="agent-input">Message or follow-up</FieldLabel>
          <Textarea
            id="agent-input"
            value={view.input}
            onChange={(event) => view.setInput(event.target.value)}
            placeholder="Ask the resident agent…"
            disabled={view.pending}
            required
          />
        </Field>
        <Field>
          <Button type="submit" disabled={view.pending || !view.input.trim()}>
            {view.pending ? 'Submitting…' : 'Send follow-up'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
export function Conversation() {
  const view = useConversation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation</CardTitle>
        <CardDescription>The resident agent continues from its durable conversation.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">{view.projection?.progress ?? view.connection}</Badge>
            <span className="text-muted-foreground text-sm" role="status">
              {view.connection}
            </span>
            <Button variant="outline" size="sm" onClick={() => void view.reconnect()}>
              Reconnect
            </Button>
            <Button variant="outline" size="sm" disabled={!view.projection?.running} onClick={() => void view.stop()}>
              Stop
            </Button>
          </div>
          <ConversationMessages projection={view.projection} />
          {view.projection?.tools.map((tool) => (
            <article key={String(tool.callId)} aria-label="Tool activity">
              <Badge variant="outline">
                {String(tool.name)} · {String(tool.status)}
              </Badge>
              {isString(tool.output) && tool.output && <pre className="tool-output">{tool.output}</pre>}
            </article>
          ))}
          <ConversationInput view={view} />
        </div>
      </CardContent>
      <CardFooter>
        {view.receipt && (
          <Alert>
            <AlertDescription>{view.receipt}</AlertDescription>
          </Alert>
        )}
      </CardFooter>
    </Card>
  )
}
