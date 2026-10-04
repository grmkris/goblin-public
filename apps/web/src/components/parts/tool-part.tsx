import type { ReactNode } from 'react'
import { Badge } from '@purrable/ui'
import type { ToolPart, ToolState } from '../../lib/parts.ts'

const STATE_LABEL: Record<ToolState, string> = {
  pending: 'queued',
  running: 'running',
  done: 'tool',
  error: 'failed',
  stopped: 'stopped',
}

/** A tool call and its result: the call's arguments and the result text, folded; `children` add to the open card. */
export function ToolCard({ part, children }: { readonly part: ToolPart; readonly children?: ReactNode }) {
  const label = part.target ? `${part.target.serverId} · ${part.target.name}` : part.call.name || 'tool'
  const args = part.target?.arguments ?? part.call.arguments
  return (
    <details className="tool-card">
      <summary>
        <Badge variant={part.state === 'error' ? 'destructive' : 'outline'}>{STATE_LABEL[part.state]}</Badge> {label}
      </summary>
      <div className="flex flex-col gap-2">
        {Object.keys(args).length > 0 && <pre className="tool-output">{JSON.stringify(args, null, 2)}</pre>}
        {part.result && <pre className="tool-output">{part.result.text}</pre>}
        {children}
      </div>
    </details>
  )
}

/** Any of the agent's own tools (`mcp_list`, ...): the generic card. */
export function GenericToolPart({ part }: { readonly part: ToolPart }) {
  return <ToolCard part={part} />
}
