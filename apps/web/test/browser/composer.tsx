import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { selectionKey, type ComposerSelection } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import { MessageComposer } from '../../src/components/composer.tsx'
import type { ComposerDraft } from '../../src/lib/composer.ts'
import '../../src/styles.css'

function Fixture() {
  const [moved, setMoved] = useState<ComposerDraft>()
  const [sent, setSent] = useState<unknown[]>([])
  const [stops, setStops] = useState(0)
  const [reject, setReject] = useState(false)
  const compact = new URL(location.href).searchParams.has('compact')
  const onSend = async (input: string, attachments: readonly string[], selections: readonly ComposerSelection[]) => {
    if (reject && selections[0] !== undefined)
      throw new InvalidInput({ reason: `composer:${selectionKey(selections[0])}` })
    setSent((current) => [...current, { input, attachments, selections }])
    return true
  }
  return (
    <main className="p-6 pt-72">
      <button type="button" onClick={() => setReject((current) => !current)}>
        Toggle failure
      </button>
      <section aria-label="Source">
        <MessageComposer
          conversation="1"
          running={false}
          onStop={() => setStops((n) => n + 1)}
          onNewThread={setMoved}
          onSend={onSend}
          compact={compact}
          attach
        />
      </section>
      {moved !== undefined && (
        <section aria-label="Moved">
          <MessageComposer
            conversation="1"
            running={false}
            draft={moved}
            onStop={() => undefined}
            onNewThread={setMoved}
            onSend={onSend}
            attach
          />
        </section>
      )}
      <output aria-label="Sent">{JSON.stringify(sent)}</output>
      <output aria-label="Stops">{stops}</output>
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('fixture root missing')
createRoot(root).render(<Fixture />)
