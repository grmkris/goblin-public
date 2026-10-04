import { useState } from 'react'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { Button } from '@purrable/ui'
import { failureText, isString, record, records, request } from '../../lib/boundary.ts'
import type { McpTarget, ToolPart } from '../../lib/parts.ts'
import { useApps } from '../apps/provider.tsx'
import { AppSlot } from '../apps/slot.tsx'
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

/** Opens the server's App view for this call, in the transcript (or the sheet, on a phone). */
function AppButton({ part, target }: { readonly part: ToolPart; readonly target: McpTarget }) {
  const { open } = useApps()
  const [error, setError] = useState('')
  async function show(): Promise<void> {
    setError('')
    try {
      const tools = records(await request(`/api/mcp/${encodeURIComponent(target.serverId)}/tools`))
      const uri = tools.find((tool) => tool.name === target.name)?.appResource
      if (!isString(uri)) {
        setError('This tool has no app view.')
        return
      }
      open(part.id, {
        serverId: target.serverId,
        uri,
        arguments: target.arguments,
        result: resultOf(part.result?.details),
      })
    } catch (cause) {
      setError(failureText(cause))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" onClick={() => void show()}>
        Show app
      </Button>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
    </div>
  )
}

/** A call to an owner's MCP server: the generic card, and its App once shown, in the row's place below it. */
export function McpToolPart({ part }: { readonly part: ToolPart }) {
  const { session } = useApps()
  const showing = session?.key === part.id
  const offerApp = part.target !== undefined && part.state === 'done' && !showing
  return (
    <div className="flex flex-col gap-2">
      <ToolCard part={part}>{offerApp && part.target && <AppButton part={part} target={part.target} />}</ToolCard>
      {showing && <AppSlot partKey={part.id} />}
    </div>
  )
}
