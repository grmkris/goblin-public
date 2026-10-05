// Adapted from grmkris/myapps packages/ui/src/components/dropdown-menu.tsx (64a64c7): the parts the site header and the
// model picker use.
import * as React from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { CheckIcon } from 'lucide-react'
import { cn } from '../lib/cn'

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset' | 'collisionPadding' | 'anchor'>

/**
 * The menu, anchored to its trigger. It never leaves the viewport: the positioner flips and shifts inside
 * `collisionPadding` (8px plus the safe area, so it keeps clear of the notch and the home indicator), and the popup is
 * capped by the space that leaves (`--available-height`, `--available-width`), scrolling as one list.
 */
function DropdownMenuContent(props: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <PositionedMenu {...props} />
    </MenuPrimitive.Portal>
  )
}

/** Mounted for each open, so the safe area is read afresh (rotation and an installed web app change it). */
function PositionedMenu({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  collisionPadding,
  anchor,
  className,
  ...props
}: DropdownMenuContentProps) {
  const padding = React.useMemo(() => collisionPadding ?? edgePadding(), [collisionPadding])
  return (
    <MenuPrimitive.Positioner
      className="isolate z-50 outline-none"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={padding}
      anchor={anchor}
    >
      <MenuPrimitive.Popup
        data-slot="dropdown-menu-content"
        className={cn(
          'z-50 max-h-(--available-height) w-max max-w-[min(22rem,var(--available-width))] min-w-[max(8rem,var(--anchor-width))] origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[transform,opacity] duration-100 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0 motion-reduce:transition-none outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:overflow-hidden pointer-coarse:p-1.5',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Positioner>
  )
}

/** 8px from each edge plus the app's safe area (`--safe-top` and friends, 0 when an app does not define them). */
function edgePadding() {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const safe = (edge: string) => (style ? Number.parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0 : 0)
  return { top: 8 + safe('top'), right: 8 + safe('right'), bottom: 8 + safe('bottom'), left: 8 + safe('left') }
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        'px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7 pointer-coarse:px-2.5 pointer-coarse:pt-2 pointer-coarse:data-inset:pl-9',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:data-highlighted:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive pointer-coarse:px-2.5 pointer-coarse:data-inset:pl-9 pointer-coarse:min-h-11 pointer-coarse:gap-2.5 pointer-coarse:text-base pointer-coarse:[&_svg:not([class*='size-'])]:size-[18px]",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pointer-coarse:pr-10 pointer-coarse:pl-2.5 pointer-coarse:data-inset:pl-9 pointer-coarse:min-h-11 pointer-coarse:gap-2.5 pointer-coarse:text-base pointer-coarse:[&_svg:not([class*='size-'])]:size-[18px]",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center pointer-coarse:right-3"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(
        '-mx-1 my-1 h-px bg-border first:hidden last:hidden [[data-slot=dropdown-menu-separator]+&]:hidden pointer-coarse:-mx-1.5 pointer-coarse:my-1.5',
        className,
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
