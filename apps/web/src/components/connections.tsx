// The owner's MCP servers: theirs first, each with what the agent may use from it, then one place to add another and,
// last, a way to try a tool by hand.
import { useCallback, useRef, useState } from 'react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
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
} from '@goblin/ui'
import { CircleAlertIcon, CircleCheckIcon, PlugIcon, PlusIcon } from 'lucide-react'
import type { ServerView } from '@goblin/contracts'
import { useConnectionLabels } from '../mcp/hooks.ts'
import { serversQuery } from '../mcp/queries.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { connectionName } from '../lib/labels.ts'
import { PageSection } from './page-section.tsx'
import { ServerCard } from './server-card.tsx'
import { ServerPicker } from './server-picker.tsx'
import { useTelegramChannel } from './telegram-control.tsx'
import { ToolConsole } from './tool-console.tsx'
import { glide } from '../lib/motion.ts'

/**
 * What the page tells the owner: something done, or a failure, which reads as one. A sign-in that came back names its
 * connection, read by its label once the list is there.
 */
type Notice =
  | { readonly tone: 'done' | 'failed'; readonly text: string }
  | { readonly tone: 'done'; readonly connected: string }

/** Where a server's sign-in came back to: connected, or why not, with the reference the callback quotes. */
const callbackNotice = (): Notice | undefined => {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const error = params.get('error')
  const ref = params.get('ref')
  if (connected !== null) return { tone: 'done', connected }
  if (error !== null)
    return { tone: 'failed', text: `Connection failed (${error}).${ref === null ? '' : ` · ref ${ref.slice(0, 8)}`}` }
  return undefined
}

/** The notice, set apart by tone: a failure is an alert in the destructive style, an outcome a quiet status. */
function NoticeAlert({ notice }: { readonly notice: Notice }) {
  const labelOf = useConnectionLabels()
  const failed = notice.tone === 'failed'
  const text =
    'connected' in notice
      ? `Connected ${labelOf(notice.connected)}. Choose which tools your agent may use.`
      : notice.text
  return (
    <Alert variant={failed ? 'destructive' : 'default'} role={failed ? 'alert' : 'status'}>
      {failed ? <CircleAlertIcon aria-hidden /> : <CircleCheckIcon aria-hidden />}
      <AlertDescription>{text}</AlertDescription>
    </Alert>
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

const SERVERS_NOTE = 'Your agent reaches another service only through a server here, and only with the tools you allow.'

/**
 * The connections in the order they came, those to one server side by side (ADR 0041), and the servers goblin supports
 * first-class first (ADR 0043).
 */
const byServer = (servers: readonly ServerView[]): readonly ServerView[] => {
  const ranked = [...servers.filter((server) => server.profile), ...servers.filter((server) => !server.profile)]
  const order = [...new Set(ranked.map((server) => server.endpoint))]
  return order.flatMap((endpoint) => servers.filter((server) => server.endpoint === endpoint))
}

/** The owner's connections, each a card; `onAdd` goes to the picker below. */
function Servers({
  onAdd,
  onDone,
  onMessage,
}: {
  readonly onAdd: () => void
  readonly onDone: (text: string) => void
  readonly onMessage: (text: string) => void
}) {
  const { data: servers, refetch } = useSuspenseQuery(serversQuery)
  const channel = useTelegramChannel(onMessage)
  // A server's card reads the list again after something changed it out of sight (its sign-in, its tools).
  const reload = useCallback(() => void refetch(), [refetch])
  return (
    <PageSection
      id="servers"
      title="Your servers"
      {...(servers.length > 0 && { count: servers.length })}
      action={
        servers.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <PlusIcon data-icon="inline-start" />
            Add a server
          </Button>
        ) : undefined
      }
      note={SERVERS_NOTE}
    >
      {servers.length === 0 && <NoServers onAdd={onAdd} />}
      {byServer(servers).map((server) => (
        <ServerCard
          key={server.connectionId}
          server={server}
          onReload={reload}
          onDone={onDone}
          onMessage={onMessage}
          channel={channel}
        />
      ))}
    </PageSection>
  )
}

export function Connections() {
  const [notice, setNotice] = useState(callbackNotice)
  const done = useCallback((text: string) => setNotice({ tone: 'done', text }), [])
  const failed = useCallback((text: string) => setNotice({ tone: 'failed', text }), [])
  // The tool console is optional: it waits for the list the servers section reads, and is absent without it.
  const connected = (useQuery(serversQuery).data ?? []).filter((server) => server.status === 'connected')
  const picker = useRef<HTMLElement>(null)
  const toPicker = () => picker.current?.scrollIntoView({ behavior: glide(), block: 'start' })
  return (
    <div className="page-stack">
      {notice !== undefined && <NoticeAlert notice={notice} />}
      <QueryBoundary
        action="list your servers"
        pending={
          <PageSection id="servers" title="Your servers" note={SERVERS_NOTE}>
            <div className="page-stack" aria-busy>
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          </PageSection>
        }
      >
        <Servers onAdd={toPicker} onDone={done} onMessage={failed} />
      </QueryBoundary>
      <PageSection id="add" title="Add a server" ref={picker}>
        <ServerPicker
          onChanged={done}
          onAdded={(server) =>
            done(`Added ${connectionName(server)}. Connect it, then choose the tools your agent may use.`)
          }
          onMessage={failed}
        />
      </PageSection>
      <ToolConsole servers={connected} />
    </div>
  )
}
