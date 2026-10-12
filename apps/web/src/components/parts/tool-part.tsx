import { type ReactNode, useMemo } from 'react'
import {
  Duration,
  JsonView,
  ToolCall,
  ToolCallContent,
  ToolCallMeta,
  ToolCallStatus,
  ToolCallTitle,
  ToolCallTrigger,
  ToolPayload,
  ToolPayloadText,
} from '@goblin/ui'
import { elapsedMs, toolLine, type ToolPart } from '../../lib/parts.ts'
import { outputBlocks, payloadView, type PayloadBlock } from '../../lib/tool-payload.ts'
import { useConnectionLabels } from '../../mcp/hooks.ts'
import { useNow } from '../use-now.ts'
import { ToolMarkdown } from './tool-markdown.tsx'

function Block({ block }: { readonly block: PayloadBlock }) {
  switch (block.kind) {
    case 'json':
      return <JsonView value={block.value} />
    case 'markdown':
      return <ToolMarkdown text={block.text} />
    case 'text':
      return <ToolPayloadText>{block.text}</ToolPayloadText>
  }
}

function ToolResult({ result }: { readonly result: NonNullable<ToolPart['result']> }) {
  const blocks = useMemo(() => outputBlocks(result), [result])
  return (
    <ToolPayload label="Output" raw={result.text} view={payloadView(blocks)}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </ToolPayload>
  )
}

/**
 * A tool call as one quiet line: lifecycle dot, "Used server · tool" (the agent's own tools in words), and its running
 * clock or final time. It opens to labelled input and output, as JSON trees, formatted Markdown or plain text;
 * `children` add to the open part (an App view, for example).
 */
export function ToolCard({ part, children }: { readonly part: ToolPart; readonly children?: ReactNode }) {
  const live = part.state === 'running' || part.state === 'pending'
  const now = useNow(live)
  const elapsed = elapsedMs(part, now)
  const { lead, server, tool } = toolLine(part, useConnectionLabels())
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
        {Object.keys(args).length > 0 && (
          <ToolPayload label="Input" raw={JSON.stringify(args, null, 2)} view="tree">
            <JsonView value={args} />
          </ToolPayload>
        )}
        {part.result && <ToolResult result={part.result} />}
        {children}
      </ToolCallContent>
    </ToolCall>
  )
}

/** Any of the agent's own tools (`mcp_list`, ...): the generic card. */
export function GenericToolPart({ part }: { readonly part: ToolPart }) {
  return <ToolCard part={part} />
}
