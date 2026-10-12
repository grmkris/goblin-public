import { createRoot } from 'react-dom/client'
import { ApprovalCard } from '../../src/components/approval-card.tsx'
import { AccessCard } from '../../src/components/interaction-cards.tsx'
import { UrlRequestCard } from '../../src/components/url-request-card.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** Records the owner's reply a card sends on the page, for the driver to read. */
const record = (text: string) => {
  const shown = document.getElementById('answered')
  if (shown !== null) shown.textContent = text
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    withQueryClient(
      <main className="flex flex-col gap-4 p-4">
        <UrlRequestCard
          interaction={{
            kind: 'url',
            callId: 'c1',
            requestId: 'mcp-url:41:c1',
            connectionId: 'sq-worker',
            name: 'create_agent',
          }}
        />
        <UrlRequestCard
          interaction={{
            kind: 'url',
            callId: 'c2',
            requestId: 'mcp-url:41:c2',
            connectionId: 'sq-worker',
            name: 'request_role',
          }}
        />
        <AccessCard
          interaction={{
            kind: 'access',
            callId: 'c3',
            connectionId: 'sq-worker',
            scope: 'sidequest:read sidequest:work',
          }}
          onAnswer={async (text) => {
            record(text)
            return true
          }}
        />
        <ApprovalCard
          interaction={{
            kind: 'approval',
            callId: 'c4',
            approvalId: 'mcp:41:c4',
            connectionId: 'mercator',
            name: 'create_job',
          }}
        />
        <output id="answered" />
      </main>,
    ),
  )
