import type { ReactNode } from 'react'
import {
  Duration,
  ToolCall,
  ToolCallContent,
  ToolCallMeta,
  ToolCallStatus,
  ToolCallTitle,
  ToolCallTrigger,
} from '@purrable/ui'
import { elapsedMs, toolLine, type ToolPart } from '../../lib/parts.ts'
import { useNow } from '../use-now.ts'

/**
 * A tool call as one quiet line: lifecycle dot, "Used server · tool" (the agent's own tools in words), and its running
 * clock or final time. It opens to the call's arguments and the result text; `children` add to the open part (an App
 * view, for example).
 */
export function ToolCard({ part, children }: { readonly part: ToolPart; readonly children?: ReactNode }) {
  const live = part.state === 'running' || part.state === 'pending'
  const now = useNow(live)
  const elapsed = elapsedMs(part, now)
  const { lead, server, tool } = toolLine(part)
  const args = part.target?.arguments ?? part.call.arguments
  return (
    <ToolCall>
      <ToolCallTrigger>
        <ToolCallStatus state={part.state} />
        <ToolCallTitle>
          {lead}
          {server !== undefined && (
            <>
              {' '}
              <b className="font-medium text-foreground">{server}</b>
            </>
          )}
          {tool !== undefined && ` · ${tool}`}
        </ToolCallTitle>
        <ToolCallMeta>
          {part.state === 'stopped' ? 'stopped' : elapsed !== undefined && <Duration ms={elapsed} running={live} />}
        </ToolCallMeta>
      </ToolCallTrigger>
      <ToolCallContent>
        {Object.keys(args).length > 0 && <pre className="tool-output">{JSON.stringify(args, null, 2)}</pre>}
        {part.result && <pre className="tool-output">{part.result.text}</pre>}
        {children}
      </ToolCallContent>
    </ToolCall>
  )
}

/** Any of the agent's own tools (`mcp_list`, ...): the generic card. */
export function GenericToolPart({ part }: { readonly part: ToolPart }) {
  return <ToolCard part={part} />
}
