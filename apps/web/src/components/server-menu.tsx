// A server's less frequent actions: Refresh, Disconnect and Remove behind one button, and Remove's confirmation.
import { useMutation } from '@tanstack/react-query'
import type { ServerView } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import { EllipsisIcon, RefreshCwIcon, Trash2Icon, UnplugIcon } from 'lucide-react'
import { removeServerMutation } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { serverTitle } from '../lib/labels.ts'

export type Action = 'connect' | 'disconnect' | 'refresh'

/** Refresh, Disconnect and Remove, kept behind one button so the card's face stays calm. */
export function ServerMenu({
  server,
  busy,
  onAct,
  onRemove,
}: {
  readonly server: ServerView
  readonly busy: boolean
  readonly onAct: (action: Action) => void
  readonly onRemove: () => void
}) {
  const connected = server.status === 'connected'
  if (!connected && server.source !== 'added') return null
  const name = serverTitle(server)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" size="icon-sm" variant="ghost" aria-label={`More for ${name}`} pending={busy} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {connected && (
          <>
            <DropdownMenuItem onClick={() => onAct('refresh')}>
              <RefreshCwIcon aria-hidden />
              Look for new tools
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAct('disconnect')}>
              <UnplugIcon aria-hidden />
              Disconnect
            </DropdownMenuItem>
          </>
        )}
        {connected && server.source === 'added' && <DropdownMenuSeparator />}
        {server.source === 'added' && (
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash2Icon aria-hidden />
            Remove…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Remove asks first: the server's sign-in and every tool grant go with it. */
export function RemoveConfirm({
  server,
  onCancel,
  onMessage,
}: {
  readonly server: ServerView
  readonly onCancel: () => void
  readonly onMessage: (message: string) => void
}) {
  const removing = useMutation(removeServerMutation)
  const pending = removing.isPending || removing.isSuccess
  const remove = () =>
    removing.mutate(server.connectionId, {
      onError: (error) => onMessage(messageOf(error, `remove ${serverTitle(server)}`)),
    })
  return (
    <div className="inline-confirm" role="alertdialog" aria-label={`Remove ${serverTitle(server)}?`}>
      <span>Remove it? Its sign-in and the tools you allowed go with it.</span>
      <Button size="sm" variant="destructive" pending={pending} onClick={remove}>
        Remove
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}
