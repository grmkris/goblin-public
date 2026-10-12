import { CopyButton } from '../ui/index.ts'

export const mcpUrl = (): string => `${window.location.origin}/mcp`

/** The link to paste into goblin or any MCP client, and the two steps after it. */
export function ConnectPanel() {
  const url = mcpUrl()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-card ps-4 pe-2 text-card-foreground ring-1 ring-foreground/10">
        <code className="min-w-0 truncate font-mono text-sm">{url}</code>
        <CopyButton text={url} label="Copy link" />
      </div>
      <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm/relaxed text-muted-foreground marker:text-muted-foreground">
        <li>In goblin or any MCP client, add a remote MCP server with this link.</li>
        <li>Approve it on the page that opens here.</li>
        <li>Ask your agent for its wallet status.</li>
      </ol>
    </div>
  )
}
