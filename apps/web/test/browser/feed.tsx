import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useQueryClient } from '@tanstack/react-query'
import type { ConversationView } from '@goblin/contracts'
import { useActivity, useApps, useConversations } from '../../src/lib/workspace/hooks.ts'
import { workspaceSync } from '../../src/lib/workspace/sync.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

const thread = (id: string, title: string): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  title,
  keepOpen: false,
  replies: 0,
  createdAt: Number(id),
})
const WORKSPACE = {
  conversations: [{ ...thread('1', 'Personal'), kind: 'main' as const }, thread('5', 'Five'), thread('6', 'Six')],
  activity: [],
  apps: [
    {
      id: '3',
      conversation: '1',
      title: 'Board',
      createdAt: 3,
      source: {
        kind: 'mcp' as const,
        callId: 'call-3',
        connectionId: 'notes',
        tool: 'board',
        uri: 'ui://notes/board.html',
      },
    },
  ],
}

/** How often this reader rendered, then what it read: what the browser test compares after each feed change. */
function Reader({ label, read }: { readonly label: string; readonly read: string }) {
  const renders = useRef(0)
  renders.current += 1
  return (
    <output aria-label={label}>
      {renders.current}:{read}
    </output>
  )
}

function AppsReader({ label }: { readonly label: string }) {
  return <Reader label={label} read={String(useApps().length)} />
}

function ActivityReader({ id }: { readonly id: string }) {
  return <Reader label={`Activity of ${id}`} read={useActivity(id)?.state ?? 'idle'} />
}

function ConversationsReader() {
  return (
    <Reader
      label="Conversations"
      read={useConversations()
        .map((view) => view.title ?? '')
        .join(',')}
    />
  )
}

/** What the feed would send, written into the cache as the feed writes it. */
function Changes() {
  const sync = workspaceSync(useQueryClient())
  return (
    <>
      <button
        type="button"
        onClick={() => sync.changes([{ type: 'conversation', conversation: thread('5', 'Five renamed') }])}
      >
        Rename five
      </button>
      <button
        type="button"
        onClick={() => sync.changes([{ type: 'activity', activity: { id: '5', state: 'working', since: Date.now() } }])}
      >
        Work in five
      </button>
    </>
  )
}

/** Readers of the workspace slices beside each other, each counting its own renders. */
function Fixture() {
  return (
    <main className="flex flex-col gap-2 p-6">
      <Changes />
      <AppsReader label="Apps reader 1" />
      <AppsReader label="Apps reader 2" />
      <ActivityReader id="5" />
      <ActivityReader id="6" />
      <ConversationsReader />
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('fixture root missing')
createRoot(root).render(withQueryClient(<Fixture />, WORKSPACE))
