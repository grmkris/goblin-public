// The owner's MCP servers: theirs first, each with what the agent may use from it, then one place to add another and,
// last, a way to try a tool by hand.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
import { PlugIcon, PlusIcon } from 'lucide-react'
import { serversQuery } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { serverTitle } from '../lib/labels.ts'
import { PageSection } from './page-section.tsx'
import { ServerCard } from './server-card.tsx'
import { ServerPicker } from './server-picker.tsx'
import { useTelegramChannel } from './telegram-control.tsx'
import { ToolConsole } from './tool-console.tsx'
import { glide } from '../lib/motion.ts'

const callbackNotice = (): string => {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const error = params.get('error')
  if (connected !== null) return `Connected ${connected}. Choose which tools your agent may use.`
  if (error !== null) return `Connection failed (${error}).`
  return ''
}

/** The owner's servers from the Query cache; `reload` reads them again after something changed them out of sight. */
function useServers(onMessage: (message: string) => void) {
  const queryClient = useQueryClient()
  const read = useQuery(serversQuery)
  useEffect(() => {
    if (read.error !== null) onMessage(messageOf(read.error, 'list your servers'))
  }, [read.error, onMessage])
  const reload = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey }),
    [queryClient],
  )
  return { servers: read.data, reload }
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
  const { servers, reload } = useServers(setMessage)
  const channel = useTelegramChannel(setMessage)
  const picker = useRef<HTMLElement>(null)
  const toPicker = () => picker.current?.scrollIntoView({ behavior: glide(), block: 'start' })
  return (
    <div className="page-stack">
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <PageSection
        id="servers"
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
        note="Your agent reaches another service only through a server here, and only with the tools you allow."
      >
        {servers === undefined && (
          <div className="page-stack" aria-busy>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}
        {servers?.length === 0 && <NoServers onAdd={toPicker} />}
        {servers?.map((server) => (
          <ServerCard
            key={server.serverId}
            server={server}
            onReload={reload}
            onMessage={setMessage}
            channel={channel}
          />
        ))}
      </PageSection>
      <PageSection id="add" title="Add a server" ref={picker}>
        <ServerPicker
          onChanged={setMessage}
          onAdded={(server) =>
            setMessage(`Added ${serverTitle(server)}. Connect it, then choose the tools your agent may use.`)
          }
          onMessage={setMessage}
        />
      </PageSection>
      <ToolConsole servers={(servers ?? []).filter((server) => server.status === 'connected')} />
    </div>
  )
}
