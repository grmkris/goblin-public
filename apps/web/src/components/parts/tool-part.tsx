import { type ReactNode, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { BotIcon } from 'lucide-react'
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
import { subagentOf } from '../../lib/threads.ts'

/** The current time, ticking once a second while `active`, so a running tool's clock advances. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

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

/** The `subagent` tool: the generic card, and a way into the subagent's own conversation once the call names it. */
export function SubagentToolPart({ part }: { readonly part: ToolPart }) {
  const subagent = subagentOf(part)
  return (
    <ToolCard part={part}>
      {subagent !== undefined && (
        <Link to="/c/$conversationId" params={{ conversationId: subagent.thread }} className="tool-link">
          <BotIcon aria-hidden />
          Open {subagent.name}
        </Link>
      )}
    </ToolCard>
  )
}
