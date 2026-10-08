import type { HomeTile } from '@goblin/contracts'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  useIsMobile,
} from '@goblin/ui'
import { XIcon } from 'lucide-react'
import { MessageText } from '../parts/text-part.tsx'

/** The fixed tile stays a glance; Open gives its complete Markdown a focused, scrollable reading surface. */
export function HomeNoteReader({
  tile,
  open,
  onOpenChange,
  returnFocus,
}: {
  readonly tile: Extract<HomeTile, { kind: 'note' }>
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly returnFocus: HTMLElement | null
}) {
  const mobile = useIsMobile()
  const body = (
    <div className="home-note-content">
      <MessageText text={tile.markdown} />
    </div>
  )
  const close = (
    <Button variant="ghost" size="icon-sm" aria-label="Close note">
      <XIcon aria-hidden />
    </Button>
  )
  if (mobile)
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent finalFocus={() => (returnFocus?.isConnected ? returnFocus : null)}>
          <header className="home-note-header">
            <DrawerTitle>{tile.title}</DrawerTitle>
            <DrawerClose render={close} />
          </header>
          <DrawerDescription className="sr-only">Full Home note. Scroll to read all content.</DrawerDescription>
          {body}
        </DrawerContent>
      </Drawer>
    )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent finalFocus={() => (returnFocus?.isConnected ? returnFocus : null)}>
        <header className="home-note-header">
          <DialogTitle>{tile.title}</DialogTitle>
          <DialogClose render={close} />
        </header>
        <DialogDescription className="sr-only">Full Home note. Scroll to read all content.</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  )
}
