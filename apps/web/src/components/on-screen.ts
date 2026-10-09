import { type RefObject, useEffect, useState } from 'react'
import type { ConversationView } from '@goblin/contracts'
import { isUnread } from '../lib/threads.ts'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** Whether the page is in front: a background tab reads nothing. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  return visible
}

/**
 * Whether an element is on screen: at least `threshold` of it in view (the strip and the scroller move panes out of
 * it, and a transcript scrolls inline threads out of it) while the page is in front. It starts on screen, so a
 * conversation opened now follows at once.
 */
export function useOnScreen(element: RefObject<HTMLElement | null>, threshold = 0): boolean {
  const front = useDocumentVisible()
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const target = element.current
    if (target === null) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), { threshold })
    observer.observe(target)
    return () => observer.disconnect()
  }, [element, threshold])
  return inView && front
}

/**
 * Marks a conversation read once it has been shown for a moment with replies the owner has not seen.
 */
export function useMarkRead(view: ConversationView, shown: boolean): void {
  const { markRead } = useWorkspaceFeed()
  const unread = isUnread(view)
  const reading = shown && unread
  useEffect(() => {
    if (!reading) return
    const timer = setTimeout(() => markRead(view.id), 800)
    return () => clearTimeout(timer)
  }, [reading, view.id, view.lastReplyAt, markRead])
}
