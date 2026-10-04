import { useState } from 'react'
import Markdown from 'react-markdown'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { Alert, AlertDescription, Badge, Button } from '@purrable/ui'
import { failureText, isString, record, records, request } from '../lib/boundary.ts'
import type { ChatMessage, ToolCallView } from '../lib/projection.ts'
import { McpApp, type AppSelection } from './mcp-app.tsx'

/** Assistant text as Markdown. Raw HTML is never rendered; links open in a new tab without a referrer. */
export function MessageText({ text }: { readonly text: string }) {
  return (
    <div className="markdown">
      <Markdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

/** The MCP server, tool and arguments of an `mcp_call`, when the call has that shape. */
function mcpTarget(call: ToolCallView | undefined) {
  if (call?.name !== 'mcp_call') return undefined
  const { serverId, name } = call.arguments
  if (!isString(serverId) || !isString(name)) return undefined
  return { serverId, name, arguments: record(call.arguments.arguments) ?? {} }
}

/** Rebuild the tool result an App expects from the (redacted) details the resident tool committed. */
function resultOf(details: unknown): CallToolResult {
  const value = record(details)
  const structured = record(value?.structuredContent)
  const meta = record(value?._meta)
  return {
    // SAFETY: the content blocks were committed from the remote CallToolResult by mcpModelResult (runtime).
    content: records(value?.content) as CallToolResult['content'],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}

function AppButton({
  target,
  details,
}: {
  readonly target: NonNullable<ReturnType<typeof mcpTarget>>
  readonly details: unknown
}) {
  const [selection, setSelection] = useState<AppSelection>()
  const [error, setError] = useState('')
  async function open(): Promise<void> {
    setError('')
    try {
      const tools = records(await request(`/api/mcp/${encodeURIComponent(target.serverId)}/tools`))
      const uri = tools.find((tool) => tool.name === target.name)?.appResource
      if (!isString(uri)) {
        setError('This tool has no app view.')
        return
      }
      setSelection({ serverId: target.serverId, uri, arguments: target.arguments, result: resultOf(details) })
    } catch (cause) {
      setError(failureText(cause))
    }
  }
  if (selection) return <McpApp selection={selection} />
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" onClick={() => void open()}>
        Show app
      </Button>
      {error && <p className="text-muted-foreground text-sm">{error}</p>}
    </div>
  )
}

function ToolResult({
  message,
  call,
}: {
  readonly message: Extract<ChatMessage, { role: 'tool' }>
  readonly call: ToolCallView | undefined
}) {
  const target = mcpTarget(call)
  const label = target ? `${target.serverId} · ${target.name}` : message.toolName || call?.name || 'tool'
  return (
    <details className="tool-card">
      <summary>
        <Badge variant={message.isError ? 'destructive' : 'outline'}>{message.isError ? 'failed' : 'tool'}</Badge>{' '}
        {label}
      </summary>
      <div className="flex flex-col gap-2">
        {call && Object.keys(call.arguments).length > 0 && (
          <pre className="tool-output">{JSON.stringify(call.arguments, null, 2)}</pre>
        )}
        <pre className="tool-output">{message.text}</pre>
        {target && !message.isError && <AppButton target={target} details={message.details} />}
      </div>
    </details>
  )
}

export function MessageView({
  message,
  calls,
  canSwitchModel = false,
}: {
  readonly message: ChatMessage
  readonly calls: ReadonlyMap<string, ToolCallView>
  /** Another model is on offer, so a provider failure can point at the picker. */
  readonly canSwitchModel?: boolean
}) {
  if (message.role === 'tool') return <ToolResult message={message} call={calls.get(message.toolCallId)} />
  if (message.role === 'user')
    return (
      <article className="bubble bubble-user">
        <p className="message-text">{message.text}</p>
      </article>
    )
  return (
    <>
      {message.text !== '' && (
        <article className="bubble bubble-assistant">
          <MessageText text={message.text} />
        </article>
      )}
      {message.failure !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>
            {message.failure.text}{' '}
            {message.failure.provider &&
              (canSwitchModel ? 'Try again later, or pick another model below.' : 'Try again later.')}
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

export function StreamNotice({ text }: { readonly text: string }) {
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}
