import { useState } from 'react'
import { HomeEdit, HomeEditResult } from '@goblin/contracts'
import { Schema } from 'effect'
import { Button, Receipt } from '@goblin/ui'
import type { ToolPart } from '../../lib/parts.ts'
import { failureText, record, request } from '../../lib/boundary.ts'
import { showHome } from '../../lib/home.ts'
import { conversationKey } from '../../lib/workspace.ts'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { ToolCard } from '../parts/tool-part.tsx'

export function HomeReceipt({ part }: { readonly part: ToolPart }) {
  const details = record(part.result?.details)
  const feed = useWorkspaceFeed()
  const workspace = useWorkspace()
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const applied = details?.kind === 'home-receipt'
  const ask = details?.kind === 'home-owner-required'
  const operationId = typeof details?.operationId === 'string' ? details.operationId : undefined
  const ids = Array.isArray(details?.tileIds)
    ? details.tileIds.filter((id): id is string => typeof id === 'string')
    : []
  async function edit(): Promise<void> {
    if (feed.home === undefined || pending) return
    setPending(true)
    try {
      const input = ask ? Schema.decodeUnknownSync(HomeEdit)(details?.edit) : undefined
      const result = Schema.decodeUnknownSync(HomeEditResult)(
        await request('/api/home', {
          body: {
            ...input,
            // @effect-diagnostics-next-line cryptoRandomUUID:off -- a new owner action has a fresh durable operation ID.
            operationId: crypto.randomUUID(),
            expectedRevision: feed.home.revision,
            ...(ask ? {} : { ops: [], undoOf: operationId }),
          },
        }),
      )
      setDone(result.kind === 'applied')
      setNotice(result.kind === 'applied' ? result.message : 'Home changed; try again.')
    } catch (cause) {
      setNotice(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  if (!applied && !ask) return <ToolCard part={part} />
  return (
    <div className="home-receipt">
      <Receipt>
        {applied && typeof details.message === 'string' ? details.message : 'Asked to change your Home tiles'}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            workspace.open(conversationKey('1'), 'beside')
            requestAnimationFrame(() => showHome(ids))
          }}
        >
          Show
        </Button>
        <Button variant="ghost" size="xs" disabled={pending || done} onClick={() => void edit()}>
          {ask ? 'Allow this edit' : 'Undo'}
        </Button>
      </Receipt>
      {notice && <Receipt role="status">{notice}</Receipt>}
    </div>
  )
}
