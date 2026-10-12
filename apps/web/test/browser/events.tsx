import { createRoot } from 'react-dom/client'
import { EVERYTHING, type ServerView, type WorkspaceSnapshot } from '@goblin/contracts'
import { Card, CardContent } from '@goblin/ui'
import { ConnectionEvents } from '../../src/components/connection-events.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

/**
 * Sidequest's worker connection, connected and sending events the owner has not set up yet (ADR 0041), one of which
 * goblin's Telegram channel already takes.
 */
const WORKER: ServerView = {
  connectionId: 'sq-worker',
  label: 'Sidequest · Worker',
  endpoint: 'https://dev.sidequest.exchange/mcp',
  status: 'connected',
  live: true,
  source: 'added',
  events: 'open',
  eventHealth: [
    {
      subscriptionId: 'sub-telegram',
      name: 'sidequest.worker.messages',
      granted: true,
      status: 'active',
      refreshBefore: null,
      lastReceiptAt: null,
      telegram: true,
    },
  ],
}

const WORKSPACE: WorkspaceSnapshot = {
  conversations: [],
  activity: [],
  apps: [],
  topics: [
    {
      id: 1,
      name: 'Personal',
      conversation: '1',
      personal: true,
      searchExcluded: false,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'system',
      createdAt: 1,
    },
    {
      id: 2,
      name: 'Sidequest',
      conversation: '20',
      searchExcluded: false,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 1,
    },
  ],
  personas: [
    {
      id: 7,
      name: 'Worker',
      avatar: { glyph: 'W', hue: 120 },
      role: 'Quotes jobs',
      instructions: 'Quote fairly.',
      setup: { mcpServers: [], skills: [], apps: [] },
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  invocations: [],
  receipts: [],
}

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    withQueryClient(
      <main className="p-4">
        <Card>
          <CardContent>
            <ConnectionEvents server={WORKER} />
          </CardContent>
        </Card>
      </main>,
      WORKSPACE,
    ),
  )
