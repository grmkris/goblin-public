// A connection's own App (ADRs 0043, 0053), opened from the sidebar, its card, a paid-job card or Start: goblin keeps
// one thread for it and the App in that thread, then shows the App's page, where its tool is called as the owner and
// the chat bar talks to that thread. The App runs in the same sandboxed frame as any MCP App and is trusted for nothing.
import { useEffect, useRef } from 'react'
import { Link, Navigate } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { openWorkspaceServerAppMutation } from '../lib/workspace/mutations.ts'
import { serversQuery } from '../mcp/queries.ts'
import { PageBar } from './page-bar.tsx'

/** Why the page has no App to show, and the way back to the connection. */
function Unavailable({ text }: { readonly text: string }) {
  return (
    <div className="app-page-note flex flex-col items-start gap-3">
      <Receipt tone="error">
        <CircleAlertIcon aria-hidden />
        <span>{text}</span>
      </Receipt>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/connections" />}>
        Back to Connections
      </Button>
    </div>
  )
}

/** Keeps the App's thread and the App once, then goes to the App's page, on its `focus` panel when one is named. */
function Opening({
  connectionId,
  title,
  focus,
}: {
  readonly connectionId: string
  readonly title: string
  readonly focus: string | undefined
}) {
  const opening = useMutation(openWorkspaceServerAppMutation)
  const { mutate } = opening
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    mutate(connectionId)
  }, [connectionId, mutate])
  if (opening.error !== null) return <Unavailable text={messageOf(opening.error, `open ${title}`)} />
  if (opening.data !== undefined)
    return (
      <Navigate
        to="/a/$appId"
        params={{ appId: opening.data.id }}
        search={focus === undefined ? {} : { focus }}
        replace
      />
    )
  return (
    <p role="status" className="app-page-note">
      Opening {title}…
    </p>
  )
}

/** Connection `connectionId`'s own App, when goblin knows its app tool, opened on its `focus` panel when one is named. */
export function ServerAppPage({ connectionId, focus }: { readonly connectionId: string; readonly focus?: string }) {
  const servers = useSuspenseQuery(serversQuery).data
  const server = servers.find((each) => each.connectionId === connectionId)
  // A profile names its app tool; a server without one may declare a global entrypoint (`ServerView.entrypoint`).
  const tool = server?.profile?.app?.tool ?? server?.entrypoint
  const title = server?.profile?.title ?? server?.label ?? connectionId
  return (
    <section className="app-page" aria-label={title}>
      <PageBar title={title} />
      {server === undefined || tool === undefined ? (
        <Unavailable text="This connection has no app goblin can open." />
      ) : server.status !== 'connected' ? (
        <Unavailable text={`Sign in to ${title} on Connections first.`} />
      ) : (
        <Opening key={connectionId} connectionId={connectionId} title={title} focus={focus} />
      )}
    </section>
  )
}
