import { type ReactNode, createContext, use, useState } from 'react'
import { Button } from '@goblin/ui'
import { ApiFailure, failureText } from '../../lib/boundary.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { useAppHost } from '../apps/host.tsx'
import { AppPlace } from '../apps/slot.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { ToolCard } from './tool-part.tsx'

/** Keeps this call's App (reopening it if it was closed) and shows it in place; says why when the tool has none. */
function ShowApp({ conversation, callId }: { readonly conversation: string; readonly callId: string }) {
  const { show } = useAppHost()
  const { keepApp } = useWorkspaceFeed()
  const [error, setError] = useState('')
  async function keep(): Promise<void> {
    setError('')
    try {
      show(await keepApp(conversation, callId))
    } catch (cause) {
      const none = cause instanceof ApiFailure && cause.tag === 'NotFound'
      setError(none ? 'This tool has no app view.' : failureText(cause))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" onClick={() => void keep()}>
        Show app
      </Button>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
    </div>
  )
}

/** The conversation the transcript parts below belong to when they host Apps; nothing shows plain tool cards. */
const AppsConversation = createContext<string | undefined>(undefined)

/** The conversation whose Apps the transcript parts here show in place; none outside one (plain cards only). */
export const useAppsConversation = (): string | undefined => use(AppsConversation)

/** Transcript parts below are `conversation`'s, with its Apps in place, or (without one) plain cards with no App. */
export function AppsIn({
  conversation,
  children,
}: {
  readonly conversation: string | undefined
  readonly children: ReactNode
}) {
  return <AppsConversation value={conversation}>{children}</AppsConversation>
}

/** A call to an owner's MCP server: the generic card, and its App in the row's place below it. */
export function McpToolPart({ part }: { readonly part: ToolPart }) {
  const conversation = use(AppsConversation)
  return conversation === undefined ? (
    <ToolCard part={part} />
  ) : (
    <McpToolWithApp part={part} conversation={conversation} />
  )
}

function McpToolWithApp({ part, conversation }: { readonly part: ToolPart; readonly conversation: string }) {
  const { apps } = useWorkspaceFeed()
  const callId = part.call.id
  const app = apps.find(
    (candidate) =>
      candidate.conversation === conversation && candidate.source.kind === 'mcp' && candidate.source.callId === callId,
  )
  const open = app !== undefined && app.closedAt === undefined && part.state === 'done'
  const offer = part.target !== undefined && part.state === 'done' && !open
  return (
    <div className="flex flex-col gap-2">
      <ToolCard part={part}>{offer && <ShowApp conversation={conversation} callId={callId} />}</ToolCard>
      {open && <AppPlace app={app} />}
    </div>
  )
}
