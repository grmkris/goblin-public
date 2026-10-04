// A quiet line that records how something ended (stopped, no answer, settled) without shouting: muted text, with
// colour only in the icon. For failures that need action, the text says what to do.
import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const receiptVariants = cva(
  'flex w-full min-w-0 items-start gap-2 text-sm text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: '[&_svg]:text-muted-foreground',
        error: '[&_svg]:text-destructive',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

function Receipt({ className, tone, ...props }: React.ComponentProps<'p'> & VariantProps<typeof receiptVariants>) {
  return <p data-slot="receipt" role="status" className={cn(receiptVariants({ tone }), className)} {...props} />
}

export { Receipt }
