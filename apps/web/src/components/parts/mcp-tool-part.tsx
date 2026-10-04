import { useState } from 'react'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { Button } from '@purrable/ui'
import { failureText, isString, record, records, request } from '../../lib/boundary.ts'
import type { McpTarget, ToolPart } from '../../lib/parts.ts'
import { McpApp, type AppSelection } from '../mcp-app.tsx'
import { ToolCard } from './tool-part.tsx'

/** Rebuild the tool result an App expects from the (redacted) details the resident tool committed. */
function resultOf(details: unknown): CallToolResult {
  const value = record(details)
  const structured = record(value?.structuredContent)
  const meta = record(value?._meta)
  return {
    // SAFETY: the content blocks were committed from the remote CallToolResult by mcpModelResult (runtime).
    content: records(value?.content) as CallToolResult['content'],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}

function AppButton({ target, details }: { readonly target: McpTarget; readonly details: unknown }) {
  const [selection, setSelection] = useState<AppSelection>()
  const [error, setError] = useState('')
  async function open(): Promise<void> {
    setError('')
    try {
      const tools = records(await request(`/api/mcp/${encodeURIComponent(target.serverId)}/tools`))
      const uri = tools.find((tool) => tool.name === target.name)?.appResource
      if (!isString(uri)) {
        setError('This tool has no app view.')
        return
      }
      setSelection({ serverId: target.serverId, uri, arguments: target.arguments, result: resultOf(details) })
    } catch (cause) {
      setError(failureText(cause))
    }
  }
  if (selection) return <McpApp selection={selection} />
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" onClick={() => void open()}>
        Show app
      </Button>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
    </div>
  )
}

/** A call to an owner's MCP server: the generic card, plus the server's App view once it succeeded. */
export function McpToolPart({ part }: { readonly part: ToolPart }) {
  return (
    <ToolCard part={part}>
      {part.target && part.state === 'done' && <AppButton target={part.target} details={part.result?.details} />}
    </ToolCard>
  )
}
