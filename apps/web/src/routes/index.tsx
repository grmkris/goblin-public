import { useCallback, useMemo, useRef } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { MAIN_THREAD } from '@purrable/contracts'
import { Chat } from '../components/chat.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import type { ThreadPanelControl } from '../components/thread-panel.tsx'

/**
 * The panel beside main: `?thread=<id>` shows a thread, `?reply=<entry>` a reply to that message of main that starts
 * one. The router reads search values as JSON, so both are numbers there (and the URL stays `?thread=53`); anything
 * else is no panel.
 */
type HomeSearch = { readonly thread?: number; readonly reply?: number }

const positive = (value: unknown): number | undefined => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const thread = positive(search.thread)
    if (thread !== undefined) return { thread }
    const reply = positive(search.reply)
    return reply === undefined ? {} : { reply }
  },
  component: Home,
})

/**
 * Main, with the panel the URL names: opening one is a step in the browser's history, so Back closes it. Opening
 * another while one is open (or a reply becoming its thread) replaces it, so Back still returns to main alone.
 */
function useThreadPanel(): ThreadPanelControl {
  const search = Route.useSearch()
  const thread = search.thread === undefined ? undefined : String(search.thread)
  const draft = search.reply
  const showing = thread !== undefined || draft !== undefined
  const navigate = useNavigate({ from: '/' })
  const router = useRouter()
  const openedHere = useRef(false)
  const show = useCallback(
    (next: HomeSearch) => {
      if (!showing) openedHere.current = true
      void navigate({ search: next, replace: showing })
    },
    [showing, navigate],
  )
  const open = useCallback((id: string) => id !== thread && show({ thread: Number(id) }), [thread, show])
  const reply = useCallback((entry: number) => entry !== draft && show({ reply: entry }), [draft, show])
  const close = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false
      router.history.back()
    } else void navigate({ search: {}, replace: true })
  }, [navigate, router])
  return useMemo(() => ({ thread, draft, open, reply, close }), [thread, draft, open, reply, close])
}

function Home() {
  const panel = useThreadPanel()
  return (
    <OwnerGate>
      <Chat thread={MAIN_THREAD} panel={panel} />
    </OwnerGate>
  )
}
