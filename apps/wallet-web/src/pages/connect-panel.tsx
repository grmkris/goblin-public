import { Card, CardContent } from '@goblin/ui'
import { CopyButton } from '../ui/index.ts'

export const mcpUrl = (): string => `${window.location.origin}/mcp`

/** The URL to paste into goblin or any MCP client, and what happens next. */
export function ConnectPanel() {
  const url = mcpUrl()
  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <code className="min-w-0 truncate text-sm">{url}</code>
            <CopyButton text={url} label="Copy MCP URL" />
          </div>
        </CardContent>
      </Card>
      <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-sm/relaxed text-muted-foreground marker:text-muted-foreground">
        <li>In goblin, or any MCP client, add a remote MCP server and paste this URL.</li>
        <li>The client opens a consent page here. Check the name and approve it.</li>
        <li>Ask your agent for its wallet status. It shows what it can spend and who enforces each limit.</li>
      </ol>
    </div>
  )
}
