import type { ReactNode } from 'react'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, SidebarTrigger } from '@purrable/ui'
import { ChevronDownIcon, ChevronRightIcon, GripVerticalIcon, XIcon } from 'lucide-react'
import type { ItemKey } from '../lib/workspace.ts'

/** Where an item came from: the conversation a thread branched from or a subagent's spawner, which it opens. */
export type Crumb = { readonly title: string; readonly open: () => void }

/**
 * A pane's floating pill instead of tabs: a grip to drag the pane, where its item came from, the item's name with its
 * menu, what it is doing, and × to close the pane (the item itself goes on). The last pane has no ×; the first offers
 * the sidebar.
 */
export function PaneHeader({
  item,
  title,
  crumb,
  status,
  menu,
  editing,
  first,
  onClose,
}: {
  readonly item: ItemKey
  readonly title: string
  readonly crumb?: Crumb | undefined
  readonly status?: ReactNode
  /** The name's menu items; without any the name is plain text. */
  readonly menu?: ReactNode
  /** Shown in place of the name while it is being renamed. */
  readonly editing?: ReactNode
  readonly first: boolean
  /** Closes the pane; absent for the last one. */
  readonly onClose?: (() => void) | undefined
}) {
  return (
    <header className="pane-header" data-pane-header>
      <div className="pane-pill" data-app-cover>
        {first && <SidebarTrigger />}
        <button type="button" className="pane-grip" data-drag-item={item} aria-label={`Move ${title}`}>
          <GripVerticalIcon aria-hidden />
        </button>
        {crumb !== undefined && (
          <>
            <button type="button" className="pane-crumb" onClick={crumb.open} title={`Open ${crumb.title}`}>
              {crumb.title}
            </button>
            <ChevronRightIcon className="pane-crumb-sep" aria-hidden />
          </>
        )}
        {editing}
        {editing === undefined && menu === undefined && <h2 className="pane-title">{title}</h2>}
        {editing === undefined && menu !== undefined && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<button type="button" className="pane-title" aria-label={`${title}: actions`} />}
            >
              <span className="truncate">{title}</span>
              <ChevronDownIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{menu}</DropdownMenuContent>
          </DropdownMenu>
        )}
        {status}
        {onClose !== undefined && (
          <Button variant="ghost" size="icon-sm" aria-label="Close pane" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
    </header>
  )
}
