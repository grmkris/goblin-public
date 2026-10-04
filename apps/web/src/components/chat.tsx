import { type RefObject, useEffect, useRef, useState } from 'react'
import { Badge } from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { BrowserPiEvents, ConversationStream, type StreamStatus } from '../lib/conversation-stream.ts'
import type { ConversationProjection } from '../lib/projection.ts'
import { StreamNotice } from './chat-message.tsx'
import { MessageComposer } from './composer.tsx'
import { Conversation } from './conversation.tsx'
import { ModelPicker, useModelChoice } from './model-picker.tsx'

function useConversation() {
  const [projection, setProjection] = useState<ConversationProjection>()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [notice, setNotice] = useState('')
  const stream = useRef<ConversationStream | undefined>(undefined)
  useEffect(() => {
    const attachment = new ConversationStream(
      {
        snapshot: (signal) => request('/api/agent/snapshot', { signal }),
        events: () => new BrowserPiEvents('/api/agent/events'),
      },
      setProjection,
      (next, detail) => {
        setStatus(next)
        setNotice(next === 'reconnecting' ? `${detail ?? 'Disconnected'}. Reconnecting…` : '')
      },
    )
    stream.current = attachment
    void attachment.reconnect()
    const resume = () => {
      if (document.visibilityState === 'visible') void attachment.reconnect()
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      attachment.dispose()
    }
  }, [])
  async function send(input: string): Promise<boolean> {
    try {
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- A fresh idempotency key for this browser submission.
      await request('/api/agent', { body: { input, operationId: crypto.randomUUID() } })
      return true
    } catch (error) {
      setNotice(failureText(error))
      return false
    }
  }
  async function stop(): Promise<void> {
    try {
      await request('/api/agent/stop', { body: {} })
    } catch (error) {
      setNotice(failureText(error))
    }
  }
  return { projection, status, notice, report: setNotice, send, stop }
}

/**
 * Keeps the transcript clear of the floating composer: `--dock-height` follows the composer's size, and
 * `--keyboard-inset` lifts it above an on-screen keyboard that covers the layout viewport (iOS Safari does not resize it).
 */
function useDockInsets(view: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = view.current
    const element = dock.current
    if (!root || !element) return
    const viewport = window.visualViewport
    const keyboard = () => {
      const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`)
    }
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize ?? element.offsetHeight
      root.style.setProperty('--dock-height', `${Math.round(height)}px`)
    })
    observer.observe(element)
    keyboard()
    viewport?.addEventListener('resize', keyboard)
    viewport?.addEventListener('scroll', keyboard)
    return () => {
      observer.disconnect()
      viewport?.removeEventListener('resize', keyboard)
      viewport?.removeEventListener('scroll', keyboard)
    }
  }, [view, dock])
}

/** The chat: the transcript fills the screen under the header, and the composer floats over its bottom edge. */
export function Chat() {
  const { projection, status, notice, report, send, stop } = useConversation()
  const { choice, choose } = useModelChoice(report)
  const view = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(view, dock)
  return (
    <section className="chat-view" aria-label="Chat" ref={view}>
      <div className="chat-conversation">
        <Conversation projection={projection} canSwitchModel={(choice?.options.length ?? 0) > 1} />
        <div className="chat-dock" ref={dock}>
          {notice && <StreamNotice text={notice} />}
          <MessageComposer
            onSend={send}
            running={projection?.running ?? false}
            onStop={() => void stop()}
            context={
              <>
                <Badge variant={status === 'connected' ? 'secondary' : 'outline'}>
                  {status === 'connected' ? (projection?.progress ?? 'Ready') : status}
                </Badge>
                <ModelPicker choice={choice} onChoose={(model) => void choose(model)} />
              </>
            }
          />
        </div>
      </div>
    </section>
  )
}
