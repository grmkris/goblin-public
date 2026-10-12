// The sidebar's pins for components (ADR 0053): what the Pinned section shows, whether something is pinned, and the
// edits. An edit starts from the pins the feed holds; when another device changed them first, it is made again, once,
// from the pins that answer brings.
import { useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  type SidebarEdit,
  type SidebarOperation,
  type SidebarPin,
  type SidebarPins,
  type SidebarTarget,
  pinKey,
} from '@goblin/contracts'
import { type Pinned, moveOperation, pinnedRows } from '../lib/pins.ts'
import { useApps, useSidebarPins } from '../lib/workspace/hooks.ts'
import { editWorkspaceSidebarMutation } from '../lib/workspace/mutations.ts'
import { serversQuery } from '../mcp/queries.ts'

/** What the owner can do with the pins, and what the sidebar shows. */
export type Pins = Pinned & {
  readonly isPinned: (target: SidebarTarget) => boolean
  readonly pin: (pin: SidebarPin) => void
  readonly unpin: (target: SidebarTarget) => void
  /** Moves a row one up (`-1`) or down (`1`); nothing at either end. */
  readonly move: (target: SidebarTarget, step: -1 | 1) => void
  /** Whether a row can move that way. */
  readonly canMove: (target: SidebarTarget, step: -1 | 1) => boolean
  readonly pending: boolean
}

export function usePins(): Pins {
  const stored = useSidebarPins()
  const servers = useQuery(serversQuery).data
  const apps = useApps()
  const pinned = useMemo(() => pinnedRows(stored, servers ?? [], apps), [stored, servers, apps])
  const editing = useMutation(editWorkspaceSidebarMutation)
  const { mutateAsync } = editing
  return useMemo(() => {
    /** The edit `operation` makes of `pins`, adopting what they show pinned by default. */
    const editOf = (pins: SidebarPins, operation: (shown: Pinned) => SidebarOperation | undefined) => {
      const shown = pins === stored ? pinned : pinnedRows(pins, servers ?? [], apps)
      const op = operation(shown)
      if (op === undefined) return undefined
      const edit: SidebarEdit = {
        expectedRevision: pins.revision,
        ...(shown.adopt.length > 0 && { adopt: shown.adopt }),
        op,
      }
      return edit
    }
    const run = (operation: (shown: Pinned, pins: SidebarPins) => SidebarOperation | undefined) => {
      const first = editOf(stored, (shown) => operation(shown, stored))
      if (first === undefined) return
      mutateAsync(first)
        .then((answer) => {
          if (answer.kind !== 'stale') return undefined
          const again = editOf(answer.sidebar, (shown) => operation(shown, answer.sidebar))
          return again === undefined ? undefined : mutateAsync(again)
        })
        // expected: the mutation's own onError shows a refusal in the feed's status; nothing is left to do here
        .catch(() => undefined)
    }
    const shownKeys = new Set(pinned.shown.map(pinKey))
    return {
      ...pinned,
      isPinned: (target) => shownKeys.has(pinKey(target)),
      pin: (pin) => run(() => ({ kind: 'pin', pin })),
      unpin: (target) => run(() => ({ kind: 'unpin', target })),
      move: (target, step) => run((shown, pins) => moveOperation(pins, shown, target, step)),
      canMove: (target, step) => moveOperation(stored, pinned, target, step) !== undefined,
      pending: editing.isPending,
    }
  }, [stored, servers, apps, pinned, mutateAsync, editing.isPending])
}
