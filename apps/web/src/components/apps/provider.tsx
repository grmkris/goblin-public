// The one live App of the chat view. "Show app" opens a session; the stage (stage.tsx) renders its single iframe and
// follows a measured Trellis pane on desktop or a phone sheet. Fullscreen remains available. Slots register their elements here; nothing re-parents the iframe.
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { useMediaQuery } from '@purrable/ui'
import { WIDE_QUERY } from '../../lib/breakpoints.ts'
import { availableModes } from '../../lib/host-context.ts'
import type { AppSelection } from './frame.tsx'

export type AppSession = {
  /** The transcript part the App came from: its inline slot. */
  readonly key: string
  readonly selection: AppSelection
  readonly mode: McpUiDisplayMode
  /** The height the App asked for inline. */
  readonly height?: number
  /** What the App last shared for the agent; sent with the owner's next message, then cleared. */
  readonly context?: string
  /** A link the App asked to open, waiting for the owner's click. */
  readonly link?: URL
}

/** Where an App can be: its inline place in the transcript (by part key) or the desktop panel. */
export type SlotName = `inline:${string}` | 'panel' | 'workspace-app' | 'workspace-fullscreen'

type Apps = {
  readonly session: AppSession | undefined
  /** A phone-sized screen: fullscreen is a bottom sheet, and there is no picture-in-picture. */
  readonly phone: boolean
  readonly available: readonly McpUiDisplayMode[]
  readonly open: (key: string, selection: AppSelection) => void
  /** Moves the App to `mode` if this screen offers it; returns the mode it is in afterwards. */
  readonly setMode: (mode: McpUiDisplayMode) => McpUiDisplayMode
  readonly setHeight: (height: number) => void
  /** Keeps (or with '', drops) what the App shares with the owner's next message. */
  readonly setContext: (text: string) => void
  /** Offers a link the App asked to open, or withdraws it. */
  readonly setLink: (link: URL | undefined) => void
  readonly close: () => void
  /** A ref callback that registers a slot's element while it is mounted. */
  readonly slot: (name: SlotName) => (element: HTMLElement | null) => void
  readonly element: (name: SlotName) => HTMLElement | undefined
  /** Tells the stage that a slot moved or resized; it re-measures on the next frame. */
  readonly kick: () => void
  readonly onKick: (listener: () => void) => () => void
}

const AppsContext = createContext<Apps | undefined>(undefined)

export function useApps(): Apps {
  const apps = use(AppsContext)
  if (apps === undefined) throw new Error('useApps must be used inside AppsProvider')
  return apps
}

function useSlots(kick: () => void) {
  const elements = useRef(new Map<SlotName, HTMLElement>())
  const callbacks = useRef(new Map<SlotName, (element: HTMLElement | null) => void>())
  const slot = useCallback(
    (name: SlotName) => {
      const existing = callbacks.current.get(name)
      if (existing) return existing
      const callback = (element: HTMLElement | null) => {
        if (element) elements.current.set(name, element)
        else elements.current.delete(name)
        kick()
      }
      callbacks.current.set(name, callback)
      return callback
    },
    [kick],
  )
  const element = useCallback((name: SlotName) => elements.current.get(name), [])
  return { slot, element }
}

export function AppsProvider({ children }: { readonly children: ReactNode }) {
  const [session, setSession] = useState<AppSession>()
  const phone = !useMediaQuery(WIDE_QUERY)
  const available = useMemo(() => availableModes(true), [])
  const listeners = useRef(new Set<() => void>())
  const kick = useCallback(() => {
    for (const listener of listeners.current) listener()
  }, [])
  const onKick = useCallback((listener: () => void) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  const { slot, element } = useSlots(kick)
  const latest = useRef({ session, available, phone })
  latest.current = { session, available, phone }
  const open = useCallback((key: string, selection: AppSelection) => {
    setSession({ key, selection, mode: latest.current.phone ? 'fullscreen' : 'inline' })
  }, [])
  const setMode = useCallback((mode: McpUiDisplayMode) => {
    const { session: current, available: modes } = latest.current
    if (current === undefined || !modes.includes(mode)) return current?.mode ?? 'inline'
    setSession({ ...current, mode })
    return mode
  }, [])
  const setHeight = useCallback((height: number) => {
    setSession((current) => (current === undefined ? current : { ...current, height }))
  }, [])
  const setContext = useCallback((text: string) => {
    setSession((current) => {
      if (current === undefined) return current
      const { context: _dropped, ...rest } = current
      return text === '' ? rest : { ...rest, context: text }
    })
  }, [])
  const setLink = useCallback((link: URL | undefined) => {
    setSession((current) => {
      if (current === undefined) return current
      const { link: _dropped, ...rest } = current
      return link === undefined ? rest : { ...rest, link }
    })
  }, [])
  const close = useCallback(() => setSession(undefined), [])
  // Crossing the tiling breakpoint keeps the iframe alive and changes only its placement.
  const previousPhone = useRef(phone)
  useEffect(() => {
    if (previousPhone.current === phone) return
    previousPhone.current = phone
    setSession((current) => (current === undefined ? current : { ...current, mode: phone ? 'fullscreen' : 'inline' }))
  }, [phone])
  const apps = useMemo(
    () => ({
      session,
      phone,
      available,
      open,
      setMode,
      setHeight,
      setContext,
      setLink,
      close,
      slot,
      element,
      kick,
      onKick,
    }),
    [session, phone, available, open, setMode, setHeight, setContext, setLink, close, slot, element, kick, onKick],
  )
  return <AppsContext value={apps}>{children}</AppsContext>
}
