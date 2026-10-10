import { type ReactNode, createContext, use, useCallback, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AppView } from '@goblin/contracts'
import { NotFound } from '@goblin/contracts/api'
import { Button } from '@goblin/ui'
import { messageOf, withRef } from '../../lib/query/app-error.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { useAppHost } from '../apps/host.tsx'
import { AppPlace } from '../apps/slot.tsx'
import { useApps } from '../../lib/workspace/hooks.ts'
import { keepWorkspaceAppMutation } from '../../lib/workspace/mutations.ts'
import { ToolCard } from './tool-part.tsx'

/** Keeps this call's App (reopening it if it was closed) and shows it in place; says why when the tool has none. */
function ShowApp({ conversation, callId }: { readonly conversation: string; readonly callId: string }) {
  const { show } = useAppHost()
  const keepApp = useMutation(keepWorkspaceAppMutation).mutateAsync
  const [error, setError] = useState('')
  async function keep(): Promise<void> {
    setError('')
    try {
      show(await keepApp({ conversation, callId }))
    } catch (cause) {
      setError(
        cause instanceof NotFound ? withRef('This tool has no app view.', cause) : messageOf(cause, 'show the app'),
      )
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
  const callId = part.call.id
  const app = useApps(
    useCallback(
      (apps: readonly AppView[]) =>
        apps.find(
          (candidate) =>
            candidate.conversation === conversation &&
            candidate.source.kind === 'mcp' &&
            candidate.source.callId === callId,
        ),
      [conversation, callId],
    ),
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
