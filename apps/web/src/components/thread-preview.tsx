import { useCallback, useEffect, useRef, useState } from 'react'
import { Schema } from 'effect'
import { Link } from '@tanstack/react-router'
import { ThreadPreview, type ThreadView } from '@purrable/contracts'
import { ChevronDownIcon, ChevronRightIcon, MessagesSquareIcon } from 'lucide-react'
import { failureText, request } from '../lib/boundary.ts'
import { relativeTime, repliesLabel, threadTitle } from '../lib/threads.ts'

const decodePreview = Schema.decodeUnknownSync(ThreadPreview)
const storageKey = (id: string) => `purrable:thread-preview:${id}`

/** Storage is a device preference; blocked storage leaves the preview expanded. */
export function readCollapsed(id: string, storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    return (storage ?? localStorage).getItem(storageKey(id)) === 'collapsed'
  } catch {
    return false
  }
}

function usePreview(id: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<ThreadPreview>()
  const [error, setError] = useState('')
  useEffect(() => {
    let visible = false
    let pending = false
    const controller = new AbortController()
    const load = async () => {
      if (!visible || pending) return
      pending = true
      try {
        const data = decodePreview(await request(`/api/threads/${id}/preview`, { signal: controller.signal }))
        setPreview((current) => ({
          ...data,
          messages: current?.messages.length === 5 ? current.messages : data.messages,
        }))
        setError('')
      } catch (cause) {
        if (!controller.signal.aborted) setError(failureText(cause))
      } finally {
        pending = false
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting)
        if (visible) void load()
      },
      { rootMargin: '120px' },
    )
    if (ref.current) observer.observe(ref.current)
    const timer = setInterval(() => void load(), 4_000)
    return () => {
      controller.abort()
      observer.disconnect()
      clearInterval(timer)
    }
  }, [id])
  return { ref, preview, error }
}

function useCollapsed(id: string) {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => setCollapsed(readCollapsed(id)), [id])
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current
      try {
        localStorage.setItem(storageKey(id), next ? 'collapsed' : 'expanded')
      } catch {
        // Storage is optional in private browsing and embedded shells.
      }
      return next
    })
  }, [id])
  return { collapsed, toggle }
}

export function PreviewMessages({ messages }: { readonly messages: ThreadPreview['messages'] }) {
  return (
    <>
      {messages.map((message, index) => (
        <div className="thread-preview-message" key={`${index}`}>
          <span className="thread-preview-author">{message.author ?? (message.role === 'user' ? 'You' : 'Agent')}</span>
          {message.text && <span className="thread-preview-text">{message.text}</span>}
          {message.quiet?.map((quiet, line) => (
            <span className="thread-preview-quiet" key={`${index}:${line}`}>
              {quiet}
            </span>
          ))}
        </div>
      ))}
    </>
  )
}

/** The rail belongs to the parent message; each thread keeps its own compact transcript and collapse preference. */
export function ThreadPreviewBlock({
  view,
  now,
  onOpen,
  started = false,
}: {
  readonly view: ThreadView
  readonly now: number
  readonly onOpen: (() => void) | undefined
  readonly started?: boolean
}) {
  const { ref, preview, error } = usePreview(view.id)
  const { collapsed, toggle } = useCollapsed(view.id)
  const busy = preview?.busy ?? view.busy
  const last = view.lastReplyAt
  return (
    <div ref={ref} className="thread-preview">
      <button type="button" className="thread-row" aria-expanded={!collapsed} onClick={toggle}>
        <MessagesSquareIcon aria-hidden />
        {started && <span className="thread-row-lead">You started a thread</span>}
        <span className="thread-row-count">
          {repliesLabel(
            preview === undefined
              ? (view.replies ?? 0)
              : preview.more + preview.messages.filter((message) => message.text !== '').length,
          )}
        </span>
        <span className="thread-row-meta">
          {threadTitle(view)}
          {last !== undefined && (
            <>
              {' '}
              · <time dateTime={new Date(last * 1000).toISOString()}>{relativeTime(last, now)}</time>
            </>
          )}
        </span>
        {busy && <span className="thread-busy" aria-label="Working" />}
        {collapsed ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
      </button>
      {!collapsed && (
        <div className="thread-preview-body">
          {preview === undefined && (
            <span className="thread-preview-quiet">{error ? 'Preview unavailable' : 'Loading preview…'}</span>
          )}
          <PreviewMessages messages={preview?.messages ?? []} />
          <div className="thread-preview-actions">
            {preview !== undefined && preview.more > 0 && (
              <button type="button" onClick={onOpen}>
                {preview.more} more replies
              </button>
            )}
            {onOpen === undefined ? (
              <Link to="/t/$threadId" params={{ threadId: view.id }}>
                Open thread
              </Link>
            ) : (
              <button type="button" onClick={onOpen}>
                Open thread
              </button>
            )}
            {busy && (
              <span className="thread-preview-quiet" aria-live="polite">
                Working in thread…
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
