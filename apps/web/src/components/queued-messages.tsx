import { useState } from 'react'
import type { QueuedInput } from '@goblin/contracts'
import { selectionKey } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { Trash2Icon } from 'lucide-react'
import { sharedContext, contextPreview } from '../lib/app-context.ts'
import { reportUnexpected } from '../lib/unexpected.ts'
import { MessageFiles } from './attachments.tsx'

/** Pending Pi inputs belong beside the composer; they become transcript messages only when Pi places them. */
export function QueuedMessages({
  inputs,
  onRemove,
}: {
  readonly inputs: readonly QueuedInput[]
  readonly onRemove?: (id: number) => Promise<boolean>
}) {
  if (inputs.length === 0) return null
  return (
    <section className="queued-messages" aria-label="Queued messages">
      <p className="queue-heading" role="status">
        Queued · {inputs.length}
      </p>
      <ol>
        {inputs.map((input, index) => {
          const message = sharedContext(input.content)
          return (
            <li key={input.id} data-submission={input.id}>
              <div className="queue-meta">
                <span>
                  {message.author ?? 'You'} · {input.mode === 'steer' ? 'Steering' : 'Follow-up'}
                </span>
                {onRemove !== undefined && <RemoveQueued id={input.id} index={index} onRemove={onRemove} />}
              </div>
              <details>
                <summary aria-label={`Expand queued message ${index + 1}`}>
                  <span className="queue-preview">{message.text || 'Selected skill'}</span>
                </summary>
              </details>
              {message.attachments !== undefined && <MessageFiles files={message.attachments} />}
              {(message.selections?.length ?? 0) > 0 && (
                <ul className="queue-references" aria-label="Selected references">
                  {message.selections?.map((option) => (
                    <li key={selectionKey(option.selection)}>
                      {option.selection.kind === 'skill' ? '/' : '@'}
                      {option.label}
                    </li>
                  ))}
                </ul>
              )}
              {message.context.length > 0 && (
                <ul className="queue-references" aria-label="Shared context">
                  {message.context.map((context, at) => (
                    <li key={`${at}:${context.from}`} title={context.text}>
                      {context.from} · {contextPreview(context.text)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** Removal disables only its own row; another queued input remains independently removable. */
function RemoveQueued({
  id,
  index,
  onRemove,
}: {
  readonly id: number
  readonly index: number
  readonly onRemove: (id: number) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Remove queued message ${index + 1}`}
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true)
        onRemove(id)
          .finally(() => setBusy(false))
          .catch(reportUnexpected)
      }}
    >
      <Trash2Icon aria-hidden />
    </Button>
  )
}
