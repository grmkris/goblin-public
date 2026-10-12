import { Button } from '@goblin/ui'
import type { Connection } from '@goblin/wallet/contract'
import { useState } from 'react'
import { useConnections, useDisconnect, useMe, useRevokeAll } from '../api/queries.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { ConfirmSheet } from '../ui/index.ts'
import { Page, RowList, Section } from '../ui/page.tsx'
import { accessOf, lastUsedOf } from './agents-model.ts'
import { ConnectPanel } from './connect-panel.tsx'
import { scopeWords } from './consent.tsx'

function AgentRow({
  connection,
  onDisconnect,
}: {
  readonly connection: Connection
  readonly onDisconnect: () => void
}) {
  return (
    <li className="flex min-h-16 items-center gap-3 py-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium uppercase"
      >
        {connection.client.slice(0, 1)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{connection.client}</span>
        <span className="text-xs text-muted-foreground">{lastUsedOf(connection)}</span>
        <span className="text-xs text-muted-foreground text-pretty" title={connection.scopes.map(scopeWords).join(' ')}>
          {accessOf(connection.scopes)}
        </span>
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
        Disconnect
      </Button>
    </li>
  )
}

/** Stops everything at once, at the foot of the page: quiet until it is needed. */
function StopAll({ onStop }: { readonly onStop: () => void }) {
  return (
    <section aria-labelledby="stop-all" className="flex flex-col gap-3 border-t border-border pt-6">
      <div className="flex flex-col gap-1">
        <h2 id="stop-all" className="text-sm font-medium">
          Stop all agent access
        </h2>
        <p className="text-sm/relaxed text-muted-foreground text-pretty">
          Disconnects every agent and revokes your allowance. Your money stays in your account.
        </p>
      </div>
      <Button type="button" variant="destructive" className="self-start" onClick={onStop}>
        Stop all access
      </Button>
    </section>
  )
}

/** The agents that can use the wallet, how to connect one, and how to cut them all off. Path: `/connections`. */
export function ConnectionsPage() {
  const connections = useConnections()
  const disconnect = useDisconnect()
  const revoke = useRevokeAll()
  const [target, setTarget] = useState<Connection>()
  const [revokeOpen, setRevokeOpen] = useState(false)
  const some = (connections.data?.length ?? 0) > 0
  // Nothing to stop for an owner with no agent connected and no allowance signed.
  const me = useMe()
  const allowed = me.data?.chains.some((chain) => chain.allowance !== undefined) === true
  return (
    <Page title="Agents" description="They spend within your limits. Disconnect one at any time.">
      <Async query={connections} rows={2}>
        {(rows) =>
          rows.length === 0 ? null : (
            <RowList>
              <ul className="divide-y divide-border">
                {rows.map((connection) => (
                  <AgentRow key={connection.id} connection={connection} onDisconnect={() => setTarget(connection)} />
                ))}
              </ul>
            </RowList>
          )
        }
      </Async>
      <Section title={some ? 'Connect another agent' : 'Connect an agent'}>
        <ConnectPanel />
      </Section>
      {(some || allowed) && <StopAll onStop={() => setRevokeOpen(true)} />}
      <ConfirmSheet
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined)
        }}
        title={`Disconnect ${target?.client ?? ''}?`}
        description="It loses access to your wallet at once. You can connect it again later."
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
        description="Every agent is disconnected and your allowance is revoked on-chain. Nothing more can be spent until you set up again."
        confirmLabel="Stop all access"
        pending={revoke.isPending}
        error={revoke.isError ? errorText(revoke.error) : undefined}
        onConfirm={() => revoke.mutate(undefined, { onSuccess: () => setRevokeOpen(false) })}
      />
    </Page>
  )
}
