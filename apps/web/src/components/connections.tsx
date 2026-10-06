// The owner's MCP servers: theirs first, each with what the agent may use from it, then one place to add another and,
// last, a way to try a tool by hand.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Schema } from 'effect'
import { ServerView } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
} from '@purrable/ui'
import { PlugIcon, PlusIcon } from 'lucide-react'
import { failureText, request } from '../lib/boundary.ts'
import { serverTitle } from '../lib/labels.ts'
import { ServerCard } from './server-card.tsx'
import { ServerPicker } from './server-picker.tsx'
import { useTelegramChannel } from './telegram-control.tsx'
import { ToolConsole } from './tool-console.tsx'

const decodeServers = Schema.decodeUnknownSync(Schema.Array(ServerView))

const callbackNotice = (): string => {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const error = params.get('error')
  if (connected !== null) return `Connected ${connected}. Choose which tools your agent may use.`
  if (error !== null) return `Connection failed (${error}).`
  return ''
}

/** The owner's servers, reloaded whenever one changes; `version` counts the loads so the suggestions keep up. */
function useServers(onMessage: (message: string) => void) {
  const [servers, setServers] = useState<readonly ServerView[]>()
  const [version, setVersion] = useState(0)
  const load = useCallback(() => {
    setVersion((current) => current + 1)
    void request('/api/mcp/servers')
      .then((data) => setServers(decodeServers(data)))
      .catch((error: unknown) => onMessage(failureText(error)))
  }, [onMessage])
  useEffect(load, [load])
  return { servers, version, load }
}

function SectionHead({
  id,
  title,
  count,
  action,
}: {
  readonly id: string
  readonly title: string
  readonly count?: number
  readonly action?: ReactNode
}) {
  return (
    <div className="section-head">
      <h2 id={id}>
        {title}
        {count !== undefined && <span className="section-count">{count}</span>}
      </h2>
      {action}
    </div>
  )
}

function NoServers({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PlugIcon />
        </EmptyMedia>
        <EmptyTitle>No servers yet</EmptyTitle>
        <EmptyDescription>
          A server lets your agent use another service, such as your notes or a browser, with only the tools you allow.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onAdd}>Add a server</Button>
      </EmptyContent>
    </Empty>
  )
}

export function Connections() {
  const [message, setMessage] = useState(callbackNotice)
  const { servers, version, load } = useServers(setMessage)
  const channel = useTelegramChannel(setMessage)
  const picker = useRef<HTMLElement>(null)
  useEffect(() => {
    if (channel.status !== undefined) load()
  }, [channel.status, load])
  const toPicker = () => picker.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const changed = (text: string) => {
    setMessage(text)
    load()
  }
  return (
    <div className="page-stack">
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <section className="page-section" aria-labelledby="servers-title">
        <SectionHead
          id="servers-title"
          title="Your servers"
          {...(servers !== undefined && servers.length > 0 && { count: servers.length })}
          action={
            servers !== undefined && servers.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={toPicker}>
                <PlusIcon data-icon="inline-start" />
                Add a server
              </Button>
            ) : undefined
          }
        />
        <p className="section-note">
          Your agent reaches another service only through a server here, and only with the tools you allow.
        </p>
        {servers === undefined && (
          <div className="page-stack" aria-busy>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}
        {servers?.length === 0 && <NoServers onAdd={toPicker} />}
        {servers?.map((server) => (
          <ServerCard key={server.serverId} server={server} onReload={load} onMessage={setMessage} channel={channel} />
        ))}
      </section>
      <section className="page-section" aria-labelledby="add-title" ref={picker}>
        <SectionHead id="add-title" title="Add a server" />
        <ServerPicker
          version={version}
          onChanged={changed}
          onAdded={(server) =>
            changed(`Added ${serverTitle(server)}. Connect it, then choose the tools your agent may use.`)
          }
          onMessage={setMessage}
        />
      </section>
      <ToolConsole servers={(servers ?? []).filter((server) => server.status === 'connected')} />
    </div>
  )
}
