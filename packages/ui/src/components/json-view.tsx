// Adapted from mnove/json-view-cn (MIT, https://github.com/mnove/json-view-cn): locally owned JSON-only rendering,
// semantic colours, bounded child lists and accessible inline strings. Upstream's license is in json-view.LICENSE.
import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '../lib/cn'
import { Button } from './button.tsx'
import { CopyButton } from './copy-button.tsx'

type Container = unknown[] | Record<string, unknown>
type Options = { readonly initialDepth: number; readonly maxItems: number }

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null
}

function serialized(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function KeyLabel({ name }: { readonly name: string | undefined }) {
  return name === undefined ? null : (
    <span className="whitespace-pre-wrap text-foreground">{JSON.stringify(name)}: </span>
  )
}

function StringValue({ value }: { readonly value: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = value.length > 120
  const shown = long && !expanded ? `${value.slice(0, 120)}…` : value
  return (
    <span className="whitespace-pre-wrap text-live">
      {JSON.stringify(shown)}
      {long && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </span>
  )
}

function Primitive({ value }: { readonly value: unknown }) {
  if (typeof value === 'string') return <StringValue value={value} />
  if (typeof value === 'number') return <span className="text-attention">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="text-success">{String(value)}</span>
  if (value === null) return <span className="text-muted-foreground italic">null</span>
  if (value === undefined) return <span className="text-muted-foreground italic">undefined</span>
  if (typeof value === 'symbol') return <span className="text-muted-foreground italic">{value.toString()}</span>
  if (typeof value === 'bigint') return <span className="text-attention">{value.toString()}</span>
  return <span className="text-muted-foreground italic">[Function]</span>
}

function childAt(value: Container, key: string, index: number): unknown {
  return Array.isArray(value) ? value[index] : value[key]
}

function ContainerNode({
  value,
  name,
  depth,
  options,
}: {
  readonly value: Container
  readonly name: string | undefined
  readonly depth: number
  readonly options: Options
}) {
  const [open, setOpen] = useState(depth < options.initialDepth)
  const [visible, setVisible] = useState(options.maxItems)
  const array = Array.isArray(value)
  const keys = array ? undefined : Object.keys(value)
  const count = array ? value.length : (keys?.length ?? 0)
  const shown = Math.min(visible, count)
  const opening = array ? '[' : '{'
  const closing = array ? ']' : '}'
  return (
    <div>
      <div className="group/json-line flex min-w-0 items-start gap-1 rounded-sm hover:bg-muted/50">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${name ?? 'JSON'}`}
          className="flex min-w-0 flex-1 items-start gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn('mt-1 size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          />
          <span className="min-w-0 wrap-anywhere">
            <KeyLabel name={name} />
            <span className="text-muted-foreground">{opening}</span>
            {(!open || count === 0) && (
              <span className="text-muted-foreground">
                {count > 0 && ` …${count} ${array ? 'items' : 'keys'} `}
                {closing}
              </span>
            )}
          </span>
        </button>
        <NodeCopy value={value} />
      </div>
      {open && count > 0 && (
        <div className="ml-1.5 flex min-w-0 flex-col border-l border-hairline pl-3">
          {Array.from({ length: shown }, (_, index) => {
            const key = keys?.[index] ?? String(index)
            const child = childAt(value, key, index)
            return <JsonNode key={key} value={child} name={key} depth={depth + 1} options={options} />
          })}
          {shown < count && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="self-start"
              onClick={() => setVisible((current) => Math.min(count, current + options.maxItems))}
            >
              Show {Math.min(options.maxItems, count - shown)} more ({count - shown} remaining)
            </Button>
          )}
          <span className="text-muted-foreground">{closing}</span>
        </div>
      )}
    </div>
  )
}

function NodeCopy({ value }: { readonly value: unknown }) {
  return (
    <span className="opacity-0 group-hover/json-line:opacity-100 group-focus-within/json-line:opacity-100 pointer-coarse:opacity-100">
      <CopyButton text={() => serialized(value)} label="Copy value" compact />
    </span>
  )
}

function JsonNode({
  value,
  name,
  depth,
  options,
}: {
  readonly value: unknown
  readonly name: string | undefined
  readonly depth: number
  readonly options: Options
}) {
  if (isContainer(value)) return <ContainerNode value={value} name={name} depth={depth} options={options} />
  return (
    <div className="group/json-line flex min-w-0 items-start gap-1 rounded-sm pl-4 hover:bg-muted/50">
      <span className="min-w-0 wrap-anywhere">
        <KeyLabel name={name} />
        <Primitive value={value} />
      </span>
      <NodeCopy value={value} />
    </div>
  )
}

/** Read-only JSON, opening its root by default and mounting nested children only when their branch opens. */
function JsonView({
  value,
  className,
  initialDepth = 1,
}: {
  readonly value: unknown
  readonly className?: string
  readonly initialDepth?: number
}) {
  return (
    <div data-slot="json-view" className={cn('min-w-0 font-mono text-xs leading-6', className)}>
      <JsonNode value={value} name={undefined} depth={0} options={{ initialDepth, maxItems: 50 }} />
    </div>
  )
}

export { JsonView }
