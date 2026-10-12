// The parts every setup screen shares: where the owner is in the steps, the screen's one heading and its sentence.
import type { ReactNode } from 'react'
import { cn } from '../../ui/index.ts'

/** "Step 1 of 2" as a row of dots, the current one drawn long, with the words for a screen reader and the eye. */
export function StepDots({ step, total }: { readonly step: number; readonly total: number }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-1.5 rounded-full',
              index + 1 === step ? 'w-5 bg-foreground' : 'w-1.5',
              index + 1 < step && 'bg-foreground/60',
              index + 1 > step && 'bg-foreground/15',
            )}
          />
        ))}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        Step {step} of {total}
      </span>
    </div>
  )
}

/** A screen's heading: the step it is, one title, one sentence. `level` is 2 inside a page that has its own title. */
export function ScreenHeader({
  step,
  total,
  title,
  level = 1,
  children,
}: {
  readonly step?: number | undefined
  readonly total: number
  readonly title: string
  readonly level?: 1 | 2
  readonly children?: ReactNode
}) {
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <header className="flex flex-col gap-3">
      {step !== undefined && <StepDots step={step} total={total} />}
      <Heading className={cn('font-semibold tracking-tight text-balance', level === 1 ? 'text-3xl' : 'text-2xl')}>
        {title}
      </Heading>
      {children !== undefined && <p className="text-base/relaxed text-muted-foreground text-pretty">{children}</p>}
    </header>
  )
}

/** One status line with a dot: muted while waiting, green once it happened, amber when it needs the owner. */
export function StatusLine({
  tone,
  children,
}: {
  readonly tone: 'waiting' | 'done' | 'attention'
  readonly children: ReactNode
}) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 text-sm tabular-nums">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          tone === 'waiting' && 'bg-muted-foreground/50 motion-safe:animate-pulse',
          tone === 'done' && 'bg-success',
          tone === 'attention' && 'bg-attention',
        )}
      />
      {children}
    </p>
  )
}
