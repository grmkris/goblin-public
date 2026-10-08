import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const inputVariants = cva('', {
  variants: {
    variant: {
      default: '',
      /** A compact name edited in a pane's floating header; touch keeps a full-size field. */
      pill: 'h-6 rounded-(--radius-pill)',
      /** A short code people copy from an email: monospaced, spaced and large enough to read back. */
      code: 'font-mono text-lg tracking-[0.2em] tabular-nums md:text-lg',
    },
  },
  defaultVariants: { variant: 'default' },
})

function Input({
  className,
  type,
  variant,
  ...props
}: React.ComponentProps<'input'> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors focus-visible:outline-hidden file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 pointer-coarse:h-11 any-pointer-coarse:h-11 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        cn(inputVariants({ variant }), className),
      )}
      {...props}
    />
  )
}

export { Input }
