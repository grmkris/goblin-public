import type { HomeOperation, HomeTile, TileSize } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import { MoreHorizontalIcon } from 'lucide-react'

const SIZES: readonly TileSize[] = ['small', 'medium', 'large', 'wide']

/** Every drag operation has a keyboard and screen-reader equivalent. */
export function HomeTileMenu({
  tile,
  index,
  count,
  pending,
  edit,
  open,
  close,
}: {
  readonly tile: HomeTile
  readonly index: number
  readonly count: number
  readonly pending: boolean
  readonly edit: (ops: readonly HomeOperation[]) => Promise<void>
  readonly open: () => void
  readonly close?: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Tile menu" disabled={pending} />}>
        <MoreHorizontalIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={open}>Open</DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === 0}
          onClick={() => void edit([{ kind: 'move', id: tile.id, index: index - 1 }])}
        >
          Move earlier
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === count - 1}
          onClick={() => void edit([{ kind: 'move', id: tile.id, index: index + 1 }])}
        >
          Move later
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SIZES.map((size) => (
          <DropdownMenuItem
            key={size}
            aria-label={`Size ${size}`}
            disabled={tile.size === size}
            onClick={() => void edit([{ kind: 'resize', id: tile.id, size }])}
          >
            Size · {size}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void edit([{ kind: 'remove', id: tile.id }])}>
          Remove from Home
        </DropdownMenuItem>
        {close !== undefined && <DropdownMenuItem onClick={close}>Close app</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
