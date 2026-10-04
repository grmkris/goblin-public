import { useCallback, useState } from 'react'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ServerView } from '@purrable/contracts'
import { Alert, AlertDescription, Button, Field, FieldGroup, FieldLabel, Input, Textarea } from '@purrable/ui'
import { failureText, isString, record, records, request } from '../lib/boundary.ts'
import { McpApp, type AppSelection } from './apps/frame.tsx'

/** Call a granted tool by hand, for debugging. Results are remote data and are shown as such. */
export function ToolConsole({ servers }: { readonly servers: readonly ServerView[] }) {
  const [serverId, setServerId] = useState('')
  const [name, setName] = useState('')
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState('')
  const [selection, setSelection] = useState<AppSelection>()
  const closeApp = useCallback(() => setSelection(undefined), [])
  const [error, setError] = useState('')
  const target = serverId || servers[0]?.serverId || ''
  async function call(): Promise<void> {
    setError('')
    setSelection(undefined)
    try {
      const parsed = record(JSON.parse(args))
      if (parsed === undefined) throw new Error('Arguments must be a JSON object')
      const base = `/api/mcp/${encodeURIComponent(target)}`
      const data = await request(`${base}/tools/call`, { body: { name, arguments: parsed } })
      setResult(JSON.stringify(data, null, 2))
      const uri = records(await request(`${base}/tools`)).find((tool) => tool.name === name)?.appResource
      if (isString(uri))
        setSelection({
          serverId: target,
          uri,
          arguments: parsed,
          // SAFETY: the runtime returned this body from the SDK-validated CallToolResult of this exact call.
          result: data as CallToolResult,
        })
    } catch (cause) {
      setError(failureText(cause))
    }
  }
  if (servers.length === 0) return null
  return (
    <details className="tool-card">
      <summary>Tool console</summary>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void call()
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="console-server">Server</FieldLabel>
            <select id="console-server" value={target} onChange={(event) => setServerId(event.target.value)}>
              {servers.map((server) => (
                <option key={server.serverId} value={server.serverId}>
                  {server.serverId}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="console-tool">Tool</FieldLabel>
            <Input id="console-tool" value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="console-args">Arguments (JSON)</FieldLabel>
            <Textarea id="console-args" value={args} onChange={(event) => setArgs(event.target.value)} />
          </Field>
          <Field>
            <Button type="submit" disabled={!name}>
              Call
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result && <pre className="tool-output">{result}</pre>}
      {selection && <McpApp selection={selection} onClose={closeApp} />}
    </details>
  )
}
