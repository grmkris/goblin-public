import { useCallback, useMemo, useRef } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { MAIN_THREAD } from '@purrable/contracts'
import { Chat, type ThreadPanelControl } from '../components/chat.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

/**
 * `?thread=<id>`: the thread open in the panel beside main. The router reads search values as JSON, so the id is a
 * number there (and the URL stays `?thread=53`); anything else is no panel.
 */
type HomeSearch = { readonly thread?: number }

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const thread = Number(search.thread)
    return Number.isSafeInteger(thread) && thread > 0 ? { thread } : {}
  },
  component: Home,
})

/**
 * Main, with a thread panel the URL names: opening one is a step in the browser's history, so Back closes it. Opening
 * another while one is open replaces it, so Back still returns to main alone.
 */
function useThreadPanel(): ThreadPanelControl {
  const search = Route.useSearch()
  const thread = search.thread === undefined ? undefined : String(search.thread)
  const navigate = useNavigate({ from: '/' })
  const router = useRouter()
  const openedHere = useRef(false)
  const open = useCallback(
    (id: string) => {
      if (id === thread) return
      if (thread === undefined) openedHere.current = true
      void navigate({ search: { thread: Number(id) }, replace: thread !== undefined })
    },
    [thread, navigate],
  )
  const close = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false
      router.history.back()
    } else void navigate({ search: {}, replace: true })
  }, [navigate, router])
  return useMemo(() => ({ thread, open, close }), [thread, open, close])
}

function Home() {
  const panel = useThreadPanel()
  return (
    <OwnerGate>
      <Chat thread={MAIN_THREAD} panel={panel} />
    </OwnerGate>
  )
}
