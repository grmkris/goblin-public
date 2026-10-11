import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppFrame, type AppSelection } from '../../src/components/apps/frame.tsx'
import { MessageOffer } from '../../src/components/apps/message-offer.tsx'
import type { QuestionAnswerReceipt } from '../../src/lib/app-message.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

/** The App the page shows, one value for the page's life as the stage keeps it: a new one would reload the frame. */
const SELECTION: AppSelection = {
  kind: 'mcp',
  connectionId: 'myplan',
  uri: 'ui://myplan/question.html',
  arguments: {},
  result: { content: [] },
}

function MessageHost() {
  const [receipt, setReceipt] = useState<QuestionAnswerReceipt>()
  const [error, setError] = useState('')
  return (
    <main className="flex flex-col gap-3 p-4">
      {error && <p role="alert">{error}</p>}
      {receipt && (
        <MessageOffer
          app="42"
          conversation="7"
          connectionId="myplan"
          resourceUri="ui://myplan/question.html"
          receipt={receipt}
          onDone={() => setReceipt(undefined)}
        />
      )}
      <AppFrame
        selection={SELECTION}
        placement={{ mode: 'inline', available: ['inline'], width: 360, height: 400 }}
        height={400}
        events={{
          report: setError,
          resize: () => undefined,
          close: () => undefined,
          requestMode: () => 'inline',
          share: () => undefined,
          offerLink: () => undefined,
          offerDownload: () => undefined,
          askGrant: async () => false,
          message: (pointer) => {
            setReceipt(pointer)
            return true
          },
        }}
      />
    </main>
  )
}
const root = document.getElementById('root')
if (root) createRoot(root).render(withQueryClient(<MessageHost />))
