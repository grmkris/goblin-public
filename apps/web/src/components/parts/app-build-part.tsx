import { useCallback, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AppView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { messageOf } from '../../lib/query/app-error.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { useNavigation } from '../../lib/navigation.ts'
import { useAppHost } from '../apps/host.tsx'
import { AppPlace } from '../apps/slot.tsx'
import { useApps } from '../../lib/workspace/hooks.ts'
import { closeWorkspaceAppMutation } from '../../lib/workspace/mutations.ts'
import { AppPowers } from './app-powers.tsx'
import { useAppsConversation } from './mcp-tool-part.tsx'
import { ToolCard } from './tool-part.tsx'

/** Opens an agent app's view, shown again first when it was closed: here in place, or as a page beside. */
function OpenApp({ app, here }: { readonly app: AppView; readonly here: boolean }) {
  const navigation = useNavigation()
  const { show } = useAppHost()
  const reopen = useMutation(closeWorkspaceAppMutation).mutateAsync
  const [error, setError] = useState('')
  async function open(): Promise<void> {
    setError('')
    try {
      show(app.closedAt === undefined ? app : await reopen({ id: app.id, closed: false }))
      if (!here) navigation.openApp(app.id)
    } catch (cause) {
      setError(messageOf(cause, 'open the app'))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" onClick={() => void open()}>
        {here ? 'Show app' : `Open ${app.title}`}
      </Button>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
    </div>
  )
}

/**
 * An `app_build` call (ADR 0021): its card, then the app's view in place when this is the newest build of it with a
 * view, or a way to open the view as a page.
 */
export function AppBuildPart({ part }: { readonly part: ToolPart }) {
  const conversation = useAppsConversation()
  const { built } = part
  const name = built?.ui === true ? built.app : undefined
  const app = useApps(
    useCallback(
      (apps: readonly AppView[]) =>
        apps.find((candidate) => candidate.source.kind === 'agent' && candidate.source.name === name),
      [name],
    ),
  )
  const inline = conversation !== undefined && built?.place === true && app !== undefined && app.closedAt === undefined
  return (
    <div className="flex flex-col gap-2">
      {built?.asks !== undefined && <AppPowers app={built.app} title={built.asks} />}
      <ToolCard part={part}>
        {app !== undefined && !inline && (
          <OpenApp app={app} here={built?.place === true && conversation !== undefined} />
        )}
      </ToolCard>
      {inline && <AppPlace app={app} />}
    </div>
  )
}
