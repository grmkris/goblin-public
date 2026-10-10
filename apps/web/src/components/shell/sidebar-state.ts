// What the sidebar keeps outside the workspace: the sections folded in this browser, where the page is, and the threads
// this browser opened recently. Folds and recent threads are device conveniences, read through useSyncExternalStore so
// the server and the first render in the browser show none.
import { useSyncExternalStore } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { recentThreads } from '../../lib/recent-threads.ts'
import { channelOf } from '../../lib/topics.ts'
import { useApps, useConversations, useTopics } from '../../lib/workspace/hooks.ts'

/** What this visit folded, whether or not storage kept it, and who to tell when it changes. */
const foldedHere = new Map<string, boolean>()
const foldListeners = new Set<() => void>()
const subscribeFolds = (listener: () => void) => {
  foldListeners.add(listener)
  return () => {
    foldListeners.delete(listener)
  }
}
function storedFold(key: string): boolean {
  const chosen = foldedHere.get(key)
  if (chosen !== undefined) return chosen
  try {
    return localStorage.getItem(key) === 'folded'
  } catch {
    // expected: storage is off in this browser, so every section starts open
    return false
  }
}

/**
 * The sections the owner folded, remembered in this browser (a convenience: without storage they open on reload). The
 * server, and the first render in the browser, show them open; the browser's choice follows.
 */
export function useFolded(section: string): readonly [boolean, () => void] {
  const key = `goblin:sidebar:${section}`
  const folded = useSyncExternalStore(
    subscribeFolds,
    () => storedFold(key),
    () => false,
  )
  const toggle = () => {
    foldedHere.set(key, !folded)
    try {
      localStorage.setItem(key, folded ? 'open' : 'folded')
    } catch {
      // expected: storage is off or full; folding is a device preference only, kept for this visit
    }
    for (const listener of foldListeners) listener()
  }
  return [folded, toggle]
}

/** Where the page is: the channel it shows (a channel's own page, or the channel of a thread or App there) and its thread. */
export function useCurrent(): { readonly channel: string | undefined; readonly thread: string | undefined } {
  const conversations = useConversations()
  const topics = useTopics()
  const apps = useApps()
  const location = useRouterState({ select: (router) => router.location })
  const [, kind, id] = /^\/([ca])\/(\d{1,12})$/u.exec(location.pathname) ?? []
  if (id === undefined) return { channel: undefined, thread: undefined }
  const chat = kind === 'a' ? apps.find((app) => app.id === id)?.conversation : id
  const thread = kind === 'c' ? location.search.thread : undefined
  return {
    channel: chat === undefined ? undefined : channelOf(chat, conversations, topics),
    thread: thread === undefined ? undefined : String(thread),
  }
}

const NO_THREADS: ReadonlySet<string> = new Set()
const noSubscription = () => () => undefined
let recentRead: { readonly ids: string; readonly set: ReadonlySet<string> } = { ids: '', set: NO_THREADS }
/** The recent threads as stored now, the same set while they are the same. */
function storedRecent(): ReadonlySet<string> {
  const ids = recentThreads()
  if (ids.join(',') !== recentRead.ids) recentRead = { ids: ids.join(','), set: new Set(ids) }
  return recentRead.set
}

/**
 * The threads this browser opened recently, read again as the page changes (a device convenience). The server, and
 * the first render in the browser, know none.
 */
export function useRecentThreads(): ReadonlySet<string> {
  // Each page change renders this again, and so reads the store again.
  useRouterState({ select: (router) => router.location.href })
  return useSyncExternalStore(noSubscription, storedRecent, () => NO_THREADS)
}
