import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Textarea } from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { BrowserPiEvents, ConversationStream, type StreamStatus } from '../lib/conversation-stream.ts'
import type { ConversationProjection, ToolCallView } from '../lib/projection.ts'
import { MessageText, MessageView, StreamNotice } from './chat-message.tsx'
import { ModelPicker, useModelChoice } from './model-picker.tsx'

function useConversation() {
  const [projection, setProjection] = useState<ConversationProjection>()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [notice, setNotice] = useState('')
  const stream = useRef<ConversationStream | undefined>(undefined)
  useEffect(() => {
    const attachment = new ConversationStream(
      {
        snapshot: (signal) => request('/api/agent/snapshot', { signal }),
        events: () => new BrowserPiEvents('/api/agent/events'),
      },
      setProjection,
      (next, detail) => {
        setStatus(next)
        setNotice(next === 'reconnecting' ? `${detail ?? 'Disconnected'}. Reconnecting…` : '')
      },
    )
    stream.current = attachment
    void attachment.reconnect()
    const resume = () => {
      if (document.visibilityState === 'visible') void attachment.reconnect()
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      attachment.dispose()
    }
  }, [])
  async function send(input: string): Promise<boolean> {
    try {
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- A fresh idempotency key for this browser submission.
      await request('/api/agent', { body: { input, operationId: crypto.randomUUID() } })
      return true
    } catch (error) {
      setNotice(failureText(error))
      return false
    }
  }
  async function stop(): Promise<void> {
    try {
      await request('/api/agent/stop', { body: {} })
    } catch (error) {
      setNotice(failureText(error))
    }
  }
  return { projection, status, notice, report: setNotice, send, stop }
}

function useAutoscroll(dependency: unknown) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [dependency])
  return end
}

function Composer({
  onSend,
  running,
  onStop,
  picker,
}: {
  readonly onSend: (input: string) => Promise<boolean>
  readonly running: boolean
  readonly onStop: () => void
  readonly picker: ReactNode
}) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(): Promise<void> {
    const value = input.trim()
    if (!value || pending) return
    setPending(true)
    if (await onSend(value)) setInput('')
    setPending(false)
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Textarea
        aria-label="Message"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={running ? 'Add a follow-up…' : 'Ask your agent…'}
        disabled={pending}
      />
      <div className="flex items-center gap-2">
        <div className="mr-auto min-w-0">{picker}</div>
        {running && (
          <Button type="button" variant="outline" onClick={onStop}>
            Stop
          </Button>
        )}
        <Button type="submit" disabled={pending || !input.trim()}>
          Send
        </Button>
      </div>
    </form>
  )
}

export function Chat() {
  const { projection, status, notice, report, send, stop } = useConversation()
  const { choice, choose } = useModelChoice(report)
  const messages = projection?.messages ?? []
  const calls = useMemo(() => {
    const map = new Map<string, ToolCallView>()
    for (const message of messages)
      if (message.role === 'assistant') for (const call of message.toolCalls) map.set(call.id, call)
    return map
  }, [messages])
  const end = useAutoscroll(`${messages.length}:${projection?.partial.length ?? 0}:${projection?.tools.length ?? 0}`)
  return (
    <section className="chat" aria-label="Conversation">
      <div className="flex items-center justify-between gap-3">
        <Badge variant={status === 'connected' ? 'secondary' : 'outline'}>
          {status === 'connected' ? (projection?.progress ?? 'Ready') : status}
        </Badge>
      </div>
      {notice && <StreamNotice text={notice} />}
      <div className="chat-log" aria-live="polite">
        {messages.length === 0 && !projection?.partial ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Your conversation starts here</EmptyTitle>
              <EmptyDescription>
                Ask anything. Your agent can use the tools you enable under Connections.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              calls={calls}
              canSwitchModel={(choice?.options.length ?? 0) > 1}
            />
          ))
        )}
        {projection?.tools
          .filter((tool) => tool.status === 'running')
          .map((tool) => (
            <p className="text-muted-foreground text-sm" key={tool.callId}>
              Running {tool.name}…
            </p>
          ))}
        {projection?.partial && (
          <article className="bubble bubble-assistant">
            <MessageText text={projection.partial} />
          </article>
        )}
        <div ref={end} />
      </div>
      <Composer
        onSend={send}
        running={projection?.running ?? false}
        onStop={() => void stop()}
        picker={<ModelPicker choice={choice} onChoose={(model) => void choose(model)} />}
      />
    </section>
  )
}
