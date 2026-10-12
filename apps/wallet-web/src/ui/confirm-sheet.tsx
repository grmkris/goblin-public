import {
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Spinner,
} from '@goblin/ui'

/** A bottom sheet that asks once before something that cannot be undone from here. */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending = false,
  error,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly pending?: boolean
  readonly error?: string | undefined
  readonly onConfirm: () => void
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {error !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="button" variant="destructive" size="lg" disabled={pending} onClick={onConfirm}>
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </Button>
          <DrawerClose render={<Button type="button" variant="outline" size="lg" disabled={pending} />}>
            Cancel
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
