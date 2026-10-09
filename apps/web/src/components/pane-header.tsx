import type { ReactNode } from 'react'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@goblin/ui'
import { ChevronDownIcon, ChevronRightIcon, GripVerticalIcon, XIcon } from 'lucide-react'
import type { ItemKey } from '../lib/workspace.ts'
import { NavigationButton } from './shell/shell.tsx'

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
  mark,
  menu,
  editing,
  first,
  onClose,
}: {
  readonly item: ItemKey
  readonly title: string
  readonly crumb?: Crumb | undefined
  readonly status?: ReactNode
  /** What the item is, as a small mark before its name. */
  readonly mark?: ReactNode
  /** The name's menu items; without any the name is plain text. */
  readonly menu?: ReactNode
  /** Shown in place of the name while it is being renamed. */
  readonly editing?: ReactNode
  readonly first: boolean
  /** Closes the pane; absent for the last one. */
  readonly onClose?: (() => void) | undefined
}) {
  return (
    <header className="pane-header" data-pane-header data-app-cover>
      <div className="pane-pill material-chrome">
        {first && <NavigationButton />}
        <button type="button" className="pane-grip" data-drag-item={item} aria-label={`Move ${title}`}>
          <GripVerticalIcon aria-hidden />
        </button>
        {mark !== undefined && <span className="pane-mark">{mark}</span>}
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
          <span className="pane-close">
            <Button variant="ghost" size="pane-icon" aria-label="Close pane" onClick={onClose}>
              <XIcon />
            </Button>
          </span>
        )}
      </div>
    </header>
  )
}
