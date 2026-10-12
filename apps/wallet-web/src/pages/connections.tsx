import { Button } from '@goblin/ui'
import type { Connection } from '@goblin/wallet/contract'
import { useState } from 'react'
import { useConnections, useDisconnect, useRevokeAll } from '../api/queries.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { ConfirmSheet, timeAgo } from '../ui/index.ts'
import { EmptyState, Page, RowList, Section } from '../ui/page.tsx'
import { ConnectPanel } from './connect-panel.tsx'
import { scopeWords } from './consent.tsx'

function ConnectionRow({
  connection,
  onDisconnect,
}: {
  readonly connection: Connection
  readonly onDisconnect: () => void
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium">{connection.client}</span>
        <span className="text-xs text-muted-foreground">
          {connection.lastUsedAt === undefined ? 'Never used' : `Last used ${timeAgo(connection.lastUsedAt)}`}
          {' · '}Connected {timeAgo(connection.createdAt)}
        </span>
        <span className="text-xs/relaxed text-muted-foreground">{connection.scopes.map(scopeWords).join(' ')}</span>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
        Disconnect
      </Button>
    </li>
  )
}

export function ConnectionsPage() {
  const connections = useConnections()
  const disconnect = useDisconnect()
  const revoke = useRevokeAll()
  const [target, setTarget] = useState<Connection>()
  const [revokeOpen, setRevokeOpen] = useState(false)
  return (
    <Page title="Connections" description="Clients that can use your wallet. Disconnecting one cuts it off at once.">
      <Section title="Connected clients">
        <Async query={connections}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="Nothing is connected" description="Add goblin or another MCP client below." />
            ) : (
              <RowList>
                <ul className="divide-y divide-border">
                  {rows.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      onDisconnect={() => setTarget(connection)}
                    />
                  ))}
                </ul>
              </RowList>
            )
          }
        </Async>
      </Section>
      <Section title="Add a client">
        <ConnectPanel />
      </Section>
      <Section title="Stop all agent access">
        <p className="max-w-prose text-sm/relaxed text-muted-foreground">
          Revokes your allowance and disconnects every client. Your funds stay in your account, and nothing the agent
          has queued will be paid. You can set up again afterwards.
        </p>
        <div>
          <Button type="button" variant="destructive" onClick={() => setRevokeOpen(true)}>
            Stop all agent access
          </Button>
        </div>
      </Section>
      <ConfirmSheet
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined)
        }}
        title={`Disconnect ${target?.client ?? ''}?`}
        description="It loses access to your wallet immediately. You can connect it again later."
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        error={disconnect.isError ? errorText(disconnect.error) : undefined}
        onConfirm={() => {
          if (target !== undefined) disconnect.mutate(target.id, { onSuccess: () => setTarget(undefined) })
        }}
      />
      <ConfirmSheet
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Stop all agent access?"
        description="Every client is disconnected and your allowance is revoked on-chain. Nothing more can be spent until you set up again."
        confirmLabel="Stop all access"
        pending={revoke.isPending}
        error={revoke.isError ? errorText(revoke.error) : undefined}
        onConfirm={() => revoke.mutate(undefined, { onSuccess: () => setRevokeOpen(false) })}
      />
    </Page>
  )
}
