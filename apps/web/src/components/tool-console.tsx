import { useCallback, useState } from 'react'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ServerView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from '@goblin/ui'
import { ChevronRightIcon } from 'lucide-react'
import { failureText, isString, record, records, request } from '../lib/boundary.ts'
import { serverTitle } from '../lib/labels.ts'
import { McpApp, type McpSelection } from './apps/frame.tsx'

type ConsoleFormProps = {
  readonly servers: readonly ServerView[]
  readonly target: string
  readonly onServer: (serverId: string) => void
  readonly name: string
  readonly onName: (name: string) => void
  readonly args: string
  readonly onArgs: (args: string) => void
  readonly calling: boolean
  readonly onCall: () => void
}

function ConsoleForm({ servers, target, onServer, name, onName, args, onArgs, calling, onCall }: ConsoleFormProps) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onCall()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="console-server">Server</FieldLabel>
          <NativeSelect id="console-server" value={target} onChange={(event) => onServer(event.target.value)}>
            {servers.map((server) => (
              <NativeSelectOption key={server.serverId} value={server.serverId}>
                {serverTitle(server)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="console-tool">Tool</FieldLabel>
          <Input id="console-tool" value={name} onChange={(event) => onName(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="console-args">Arguments (JSON)</FieldLabel>
          <Textarea id="console-args" value={args} onChange={(event) => onArgs(event.target.value)} />
        </Field>
        <Field orientation="horizontal">
          <Button type="submit" pending={calling} disabled={!name}>
            Call
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** Call an allowed tool by hand, to check a server works. Results are remote data and are shown as such. */
export function ToolConsole({ servers }: { readonly servers: readonly ServerView[] }) {
  const [serverId, setServerId] = useState('')
  const [name, setName] = useState('')
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState('')
  const [selection, setSelection] = useState<McpSelection>()
  const closeApp = useCallback(() => setSelection(undefined), [])
  const [error, setError] = useState('')
  const [calling, setCalling] = useState(false)
  const target = serverId || servers[0]?.serverId || ''
  async function call(): Promise<void> {
    setError('')
    setSelection(undefined)
    setCalling(true)
    try {
      const parsed = record(JSON.parse(args))
      if (parsed === undefined) throw new Error('Arguments must be a JSON object')
      const base = `/api/mcp/${encodeURIComponent(target)}`
      const data = await request(`${base}/tools/call`, { body: { name, arguments: parsed } })
      setResult(JSON.stringify(data, null, 2))
      const uri = records(await request(`${base}/tools`)).find((tool) => tool.name === name)?.appResource
      if (isString(uri))
        setSelection({
          kind: 'mcp',
          serverId: target,
          uri,
          arguments: parsed,
          // SAFETY: the runtime returned this body from the SDK-validated CallToolResult of this exact call.
          result: data as CallToolResult,
        })
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setCalling(false)
    }
  }
  if (servers.length === 0) return null
  return (
    <Card>
      <Collapsible>
        <div className="card-stack">
          <CardHeader>
            <CardTitle>
              <CollapsibleTrigger render={<button type="button" className="console-trigger" />}>
                <ChevronRightIcon aria-hidden />
                Try a tool
              </CollapsibleTrigger>
            </CardTitle>
            <CardDescription>Call an allowed tool by hand, to check that a server works.</CardDescription>
          </CardHeader>
          <CollapsibleContent>
            <CardContent>
              <div className="page-stack">
                <ConsoleForm
                  servers={servers}
                  target={target}
                  onServer={setServerId}
                  name={name}
                  onName={setName}
                  args={args}
                  onArgs={setArgs}
                  calling={calling}
                  onCall={() => void call()}
                />
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {result && <pre className="tool-output">{result}</pre>}
                {selection && <McpApp selection={selection} onClose={closeApp} />}
              </div>
            </CardContent>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </Card>
  )
}
