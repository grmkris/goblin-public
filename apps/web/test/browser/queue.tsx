import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageComposer } from '../../src/components/composer.tsx'
import { QueuedMessages } from '../../src/components/queued-messages.tsx'
import { useConversation, useDockInsets } from '../../src/components/use-conversation.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

/** Real shared hooks, queue and composer, with HTTP/event fixtures supplied by the browser test. */
function Dock({ inline }: { readonly inline: boolean }) {
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  const conversation = useConversation('1')
  return (
    <section
      className={inline ? 'p-4' : 'chat-view'}
      ref={pane}
      style={inline ? undefined : { height: '60vh', position: 'relative' }}
      aria-label={inline ? 'Inline thread' : 'Full conversation'}
    >
      <div className={inline ? undefined : 'chat-dock'} ref={dock}>
        <div className={inline ? undefined : 'dock-cards'}>
          {conversation.notice !== '' && <p role="alert">{conversation.notice}</p>}
          {conversation.projection?.queueNotice !== '' && <p role="status">{conversation.projection?.queueNotice}</p>}
          <QueuedMessages inputs={conversation.projection?.queued ?? []} onRemove={conversation.removeQueued} />
        </div>
        <div className="dock-composer">
          <MessageComposer
            conversation="1"
            compact={inline}
            running={conversation.projection?.running ?? false}
            onStop={() => void conversation.stop()}
            onNewThread={() => undefined}
            onSend={(input, attachments, selections) =>
              conversation.send(input, undefined, { attachments, selections })
            }
          />
        </div>
      </div>
    </section>
  )
}
const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    withQueryClient(
      <>
        <Dock inline={false} />
        <Dock inline />
      </>,
    ),
  )
