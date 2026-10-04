import { useEffect, useState } from 'react'
import type { CallToolResult } from '@modelcontextprotocol/client'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
} from '@purrable/ui'
import { isString, record, records, request, text } from '../lib/boundary.ts'
import { McpApp, type AppSelection } from './mcp-app.tsx'

async function mutateGrant(
  method: 'POST' | 'DELETE',
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const response = await fetch('/api/mcp/grants', {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Grant update failed (${response.status})`)
  return records(record(await request('/api/mcp/grants'))?.grants)
}
// oxlint-disable-next-line eslint/max-lines-per-function -- This hook owns one bounded MCP screen state machine so each mutation shares the same pending/error lifecycle.
function useMcpWorkspace() {
  const [servers, setServers] = useState<Record<string, unknown>[]>([])
  const [serverId, setServerId] = useState('')
  const [tools, setTools] = useState<Record<string, unknown>[]>([])
  const [toolName, setToolName] = useState('')
  const [argumentsJson, setArgumentsJson] = useState('{}')
  const [grantName, setGrantName] = useState('')
  const [capability, setCapability] = useState<'tool' | 'resource'>('tool')
  const [grants, setGrants] = useState<Record<string, unknown>[]>([])
  const [result, setResult] = useState<unknown>()
  const [selection, setSelection] = useState<AppSelection>()
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      request('/api/mcp/servers', undefined, controller.signal),
      request('/api/mcp/grants', undefined, controller.signal),
    ])
      .then(([serverData, grantData]) => {
        setServers(records(record(serverData)?.servers))
        setGrants(records(record(grantData)?.grants))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Discovery failed')
      })
    return () => controller.abort()
  }, [])
  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true)
    try {
      await action()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Request failed')
    } finally {
      setPending(false)
    }
  }
  function connect(id: string): Promise<void> {
    setServerId(id)
    setTools([])
    setToolName('')
    setResult(undefined)
    setSelection(undefined)
    return run(async () => {
      const data = await request(`/api/mcp/${encodeURIComponent(id)}/connect`, {})
      setTools(records(record(data)?.tools))
      setStatus(`Connected to ${id}`)
    })
  }
  function grant(): Promise<void> {
    return run(async () => {
      setGrants(
        await mutateGrant('POST', { clientId: 'owner-session', serverId, capability, name: grantName, scopes: [] }),
      )
      setStatus('Grant saved. Connect again to refresh available capabilities.')
      setGrantName('')
    })
  }
  function revoke(grantRecord: Record<string, unknown>): Promise<void> {
    return run(async () => {
      setGrants(await mutateGrant('DELETE', grantRecord))
      setSelection(undefined)
      setStatus('Grant revoked')
    })
  }
  function call(): Promise<void> {
    setSelection(undefined)
    return run(async () => {
      const parsed: unknown = JSON.parse(argumentsJson)
      const args = record(parsed)
      if (!args) throw new Error('Tool arguments must be a JSON object')
      const data = await request(`/api/mcp/${encodeURIComponent(serverId)}/tools/call`, {
        name: toolName,
        arguments: args,
      })
      setResult(data)
      const tool = tools.find((item) => item.name === toolName)
      const meta = record(tool?._meta)
      const uri = record(meta?.ui)?.resourceUri ?? meta?.['ui/resourceUri']
      if (isString(uri) && uri.startsWith('ui://')) {
        // SAFETY: Authenticated endpoint returns SDK-validated CallToolResult; the App remains bound to this originating server.
        setSelection({ serverId, uri, arguments: args, result: data as CallToolResult })
      }
      setStatus('Tool returned')
    })
  }
  const visibleTools = tools.filter((tool) => {
    const visibility = record(record(tool._meta)?.ui)?.visibility
    return !Array.isArray(visibility) || visibility.includes('model')
  })
  return {
    servers,
    serverId,
    visibleTools,
    toolName,
    setToolName,
    argumentsJson,
    setArgumentsJson,
    grantName,
    setGrantName,
    capability,
    setCapability,
    grants,
    result,
    selection,
    status,
    pending,
    connect,
    grant,
    revoke,
    call,
  }
}
type McpView = ReturnType<typeof useMcpWorkspace>
function GrantForm({ view }: { readonly view: McpView }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void view.grant()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="grant-kind">Grant capability</FieldLabel>
          <select
            id="grant-kind"
            value={view.capability}
            onChange={(event) => view.setCapability(event.target.value === 'resource' ? 'resource' : 'tool')}
          >
            <option value="tool">Tool</option>
            <option value="resource">Resource</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="grant-name">Exact tool name or resource URI</FieldLabel>
          <Input
            id="grant-name"
            value={view.grantName}
            onChange={(event) => view.setGrantName(event.target.value)}
            required
          />
        </Field>
        <Field>
          <Button type="submit" variant="outline" disabled={view.pending || !view.grantName}>
            Grant access
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
function ToolForm({ view }: { readonly view: McpView }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void view.call()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="tool-name">Tool</FieldLabel>
          <select
            id="tool-name"
            value={view.toolName}
            onChange={(event) => view.setToolName(event.target.value)}
            required
          >
            <option value="">Select a tool</option>
            {view.visibleTools.map((tool) => (
              <option key={String(tool.name)} value={String(tool.name)}>
                {String(tool.name)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="tool-arguments">Arguments (JSON)</FieldLabel>
          <Textarea
            id="tool-arguments"
            value={view.argumentsJson}
            onChange={(event) => view.setArgumentsJson(event.target.value)}
            required
          />
        </Field>
        <Field>
          <Button type="submit" disabled={view.pending || !view.toolName}>
            Run tool
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
function Grants({ view }: { readonly view: McpView }) {
  return view.grants.map((grant) => (
    <div
      className="flex flex-wrap items-center gap-2"
      key={`${String(grant.serverId)}:${String(grant.capability)}:${String(grant.name)}`}
    >
      <Badge variant="outline">
        {String(grant.serverId)} · {String(grant.capability)} · {String(grant.name)}
      </Badge>
      <Button size="sm" variant="ghost" onClick={() => void view.revoke(grant)}>
        Revoke
      </Button>
    </div>
  ))
}
export function McpWorkspace() {
  const view = useMcpWorkspace()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected tools & Apps</CardTitle>
        <CardDescription>Grant exact tools and resources on their originating server.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-2">
            {view.servers.map(
              (server) =>
                isString(server.serverId) && (
                  <Button
                    key={server.serverId}
                    variant="outline"
                    disabled={view.pending}
                    onClick={() => void view.connect(String(server.serverId))}
                  >
                    Connect {server.serverId}
                  </Button>
                ),
            )}
          </div>
          {view.serverId && (
            <>
              <Badge variant="secondary">{view.serverId}</Badge>
              <GrantForm view={view} />
              <ToolForm view={view} />
            </>
          )}
          <Grants view={view} />
          {view.result !== undefined && (
            <details open>
              <summary>Tool result</summary>
              <pre className="tool-output">
                {text(record(view.result)?.content) || JSON.stringify(view.result, null, 2)}
              </pre>
            </details>
          )}
          {view.selection && <McpApp selection={view.selection} />}
        </div>
      </CardContent>
      <CardFooter>
        {view.status && (
          <Alert>
            <AlertDescription>{view.status}</AlertDescription>
          </Alert>
        )}
      </CardFooter>
    </Card>
  )
}
