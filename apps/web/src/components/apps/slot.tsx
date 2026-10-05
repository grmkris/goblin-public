// Places the App stage can follow. Inline, the App's tool row in the transcript holds a slot as tall as the App asked;
// when the App is elsewhere (panel, sheet, picture-in-picture) the row shows where it went and brings it back. The
// desktop side panel is a slot too, resizable from its left edge.
import { useCallback, useRef } from 'react'
import { AppWindowIcon } from 'lucide-react'
import { Button } from '@purrable/ui'
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

const WHERE = {
  fullscreen: 'is fullscreen',
  pip: 'is in picture in picture',
  inline: 'is in a workspace pane',
} as const

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
export function AppSlot({ partKey: _partKey }: { readonly partKey: string }) {
  const { session, phone } = useApps()
  return session === undefined ? null : <AppNote phone={phone} />
}

/** Trellis moves this empty slot; the opaque App iframe stays in AppLayer's fixed stage. */
export function WorkspaceAppSlot() {
  const ref = useSlot('workspace-app')
  return <div ref={ref} className="workspace-app-slot" />
}
