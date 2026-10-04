// Places the App stage can follow. Inline, the App's tool row in the transcript holds a slot as tall as the App asked;
// when the App is elsewhere (panel, sheet, picture-in-picture) the row shows where it went and brings it back. The
// desktop side panel is a slot too, resizable from its left edge.
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from 'react'
import { AppWindowIcon } from 'lucide-react'
import { Button } from '@purrable/ui'
import { CHROME_HEIGHT, panelWidth } from '../../lib/app-stage.ts'
import { inlineHeight } from '../../lib/host-context.ts'
import { type SlotName, useApps } from './provider.tsx'

/** A ref callback that registers the slot's element under `name` and tells the stage whenever it resizes. */
function useSlot(name: SlotName) {
  const { slot, kick } = useApps()
  const register = slot(name)
  const observer = useRef<ResizeObserver>(undefined)
  return useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect()
      observer.current = undefined
      if (node) {
        observer.current = new ResizeObserver(kick)
        observer.current.observe(node)
      }
      register(node)
    },
    [register, kick],
  )
}

const WHERE = { fullscreen: 'is in the side panel', pip: 'is in picture in picture', inline: '' } as const

/** Where the App went, with a way back; on a phone, inline means the App waits here to be opened. */
function AppNote({ phone }: { readonly phone: boolean }) {
  const { session, setMode, close } = useApps()
  if (session === undefined) return null
  const sheetOpen = phone && session.mode === 'fullscreen'
  const where = phone ? (sheetOpen ? 'is open' : '') : WHERE[session.mode]
  return (
    <div className="app-slot-note">
      <AppWindowIcon aria-hidden />
      <span className="truncate">
        App from {session.selection.serverId} {where}
      </span>
      {!sheetOpen && (
        <Button variant="outline" size="sm" onClick={() => setMode(phone ? 'fullscreen' : 'inline')}>
          {phone ? 'Open' : 'Bring back'}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={close}>
        Close
      </Button>
    </div>
  )
}

/** The App's place in its tool row: the live slot while inline, otherwise a note of where it is. */
export function AppSlot({ partKey }: { readonly partKey: string }) {
  const { session, phone } = useApps()
  const register = useSlot(`inline:${partKey}`)
  const live = session?.mode === 'inline' && !phone
  const height = CHROME_HEIGHT + inlineHeight(session?.height, typeof window === 'undefined' ? 900 : window.innerHeight)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (live && box.current) box.current.style.height = `${height}px`
  }, [live, height])
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      box.current = node
      register(node)
    },
    [register],
  )
  if (session === undefined) return null
  return live ? <div ref={ref} className="app-slot" /> : <AppNote phone={phone} />
}

const WIDTH_KEY = 'purrable.appPanelWidth'

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? value : 520
  } catch {
    return 520
  }
}

/** The desktop side panel the App fills in fullscreen mode; drag its left edge to resize it. */
export function AppPanel() {
  const ref = useSlot('panel')
  const panel = useRef<HTMLElement>(null)
  const width = useRef(storedWidth())
  const apply = () => {
    const view = { width: window.innerWidth, height: window.innerHeight, top: 0 }
    width.current = panelWidth(width.current, view)
    if (panel.current) panel.current.style.width = `${width.current}px`
  }
  useEffect(() => {
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  })
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = width.current
    const move = (moved: PointerEvent) => {
      width.current = startWidth + startX - moved.clientX
      apply()
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      try {
        localStorage.setItem(WIDTH_KEY, String(width.current))
      } catch {
        // Private browsing: the width lasts for this visit only.
      }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <aside ref={panel} className="app-panel" aria-label="App">
      <div
        className="app-panel-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the app panel"
        onPointerDown={resize}
      />
      <div ref={ref} className="app-panel-slot" />
    </aside>
  )
}
