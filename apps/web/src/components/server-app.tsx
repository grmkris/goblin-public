// A first-class server's own App as a page (ADR 0043): Mercator's balance, jobs and funding, opened with one tap from its
// card or from a paid-job card's wallet line. The owner opens it, so its app tool is called as the owner; the App runs in
// the same sandboxed frame as any MCP App, fills the pane below the bar, and is trusted for nothing.
import type { CallToolResult } from '@modelcontextprotocol/client'
import { Link } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { serverAppQuery, serversQuery } from '../mcp/queries.ts'
import { McpAppPage } from './apps/frame.tsx'
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

/** The App, once its tool answered: in the frame, or why not. */
function Opened({
  connectionId,
  tool,
  title,
}: {
  readonly connectionId: string
  readonly tool: string
  readonly title: string
}) {
  const opened = useQuery(serverAppQuery(connectionId, tool))
  if (opened.error !== null) return <Unavailable text={messageOf(opened.error, `open ${title}`)} />
  if (opened.data === undefined)
    return (
      <p role="status" className="app-page-note">
        Opening {title}…
      </p>
    )
  const { result, uri } = opened.data
  if (uri === undefined) return <Unavailable text={`${title} did not offer its app.`} />
  return (
    <McpAppPage
      // SAFETY: the runtime returned this body from the SDK-validated CallToolResult of this exact call.
      selection={{ kind: 'mcp', connectionId, uri, arguments: {}, result: result as CallToolResult }}
      onClose={() => window.history.back()}
    />
  )
}

/** Connection `connectionId`'s own App, when goblin knows its app tool. */
export function ServerAppPage({ connectionId }: { readonly connectionId: string }) {
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
        <Opened connectionId={connectionId} tool={tool} title={title} />
      )}
    </section>
  )
}
