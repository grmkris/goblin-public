// The tools a server offers and which of them the agent may call. Every switch is an exact owner grant for one tool
// (or, for an App, the App's resource and its tools). Names, descriptions and hints come from the server: they are
// shown as its claims and never grant anything.
import { useId, useState } from 'react'
import type { ToolView } from '@goblin/contracts'
import { Badge, Button, Switch } from '@goblin/ui'
import { failureText, request } from '../lib/boundary.ts'
import { AppTile } from './apps/app-tile.tsx'

type Tools = readonly ToolView[]

/** Which tools have a change in flight, so their switches wait for it. */
function usePending() {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const mark = (names: readonly string[], on: boolean) =>
    setPending((current) => {
      const next = new Set(current)
      for (const name of names) {
        if (on) next.add(name)
        else next.delete(name)
      }
      return next
    })
  async function during(names: readonly string[], work: () => Promise<void>): Promise<void> {
    mark(names, true)
    try {
      await work()
    } finally {
      mark(names, false)
    }
  }
  return { pending, during }
}

/** One tool and its switch. */
function ToolRow({
  tool,
  pending,
  onToggle,
  onAskFirst,
}: {
  readonly tool: ToolView
  readonly pending: boolean
  readonly onToggle: (allowed: boolean) => void
  readonly onAskFirst: (enabled: boolean) => void
}) {
  const id = useId()
  return (
    <li className="grant-row">
      <span className="grant-text">
        <span className="grant-name">
          <span id={id}>{tool.title ?? tool.name}</span>
          {tool.title !== undefined && <code>{tool.name}</code>}
          {tool.readOnlyHint === true && <Badge variant="outline">says read-only</Badge>}
          {tool.destructiveHint === true && <Badge variant="destructive">says destructive</Badge>}
          {!tool.modelVisible && <Badge variant="outline">App only</Badge>}
        </span>
        {tool.description && <span className="grant-about">{tool.description}</span>}
      </span>
      {tool.granted && (
        <Button
          size="xs"
          variant={tool.askFirst === true ? 'outline' : 'ghost'}
          disabled={pending}
          aria-pressed={tool.askFirst === true}
          onClick={() => onAskFirst(tool.askFirst !== true)}
        >
          {tool.askFirst === true ? 'Ask first' : 'Run when needed'}
        </Button>
      )}
      <Switch
        checked={tool.granted}
        disabled={pending}
        aria-busy={pending}
        aria-labelledby={id}
        onCheckedChange={(checked) => onToggle(checked)}
      />
    </li>
  )
}

/** An App and the exact tools it uses: one switch allows them all, and each stays listed and adjustable. */
function AppGroup({
  serverId,
  uri,
  tools,
  pending,
  onAllow,
  onToggle,
  onAskFirst,
}: {
  readonly serverId: string
  readonly uri: string
  readonly tools: Tools
  readonly pending: ReadonlySet<string>
  readonly onAllow: (allowed: boolean) => void
  readonly onToggle: (tool: ToolView, allowed: boolean) => void
  readonly onAskFirst: (tool: ToolView, enabled: boolean) => void
}) {
  const id = useId()
  return (
    <li className="grant-app">
      <div className="grant-row">
        <AppTile origin={serverId} />
        <span className="grant-text">
          <span id={id} className="grant-name">
            Its App
          </span>
          <code className="grant-about">{uri}</code>
        </span>
        <Switch
          checked={tools.every((tool) => tool.granted)}
          disabled={tools.some((tool) => pending.has(tool.name))}
          aria-labelledby={id}
          onCheckedChange={(checked) => onAllow(checked)}
        />
      </div>
      <ul className="grant-list">
        {tools.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            pending={pending.has(tool.name)}
            onToggle={(allowed) => onToggle(tool, allowed)}
            onAskFirst={(enabled) => onAskFirst(tool, enabled)}
          />
        ))}
      </ul>
    </li>
  )
}

/** How many tools are allowed, with Allow all and None for the whole server. */
function GrantsHead({
  tools,
  busy,
  onAll,
}: {
  readonly tools: Tools
  readonly busy: boolean
  readonly onAll: (allowed: boolean) => void
}) {
  const allowed = tools.filter((tool) => tool.granted).length
  return (
    <div className="server-part-head">
      <h3 className="server-part-title">
        Tools <span className="server-part-count">{`${allowed} of ${tools.length} allowed`}</span>
      </h3>
      {allowed < tools.length && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => onAll(true)}>
          Allow all
        </Button>
      )}
      {allowed > 0 && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => onAll(false)}>
          None
        </Button>
      )}
    </div>
  )
}

const names = (list: Tools): readonly string[] => list.map((each) => each.name)

const appsOf = (tools: Tools): readonly string[] => [
  ...new Set(tools.flatMap((tool) => (tool.appResource === undefined ? [] : [tool.appResource]))),
]

/** The grant calls behind the switches; each updates the list once the runtime has it. */
function useGrants(
  serverId: string,
  tools: Tools,
  setTools: (update: (tools: Tools) => Tools) => void,
  onMessage: (message: string) => void,
) {
  const { pending, during } = usePending()
  const grant = (changed: (tool: ToolView) => boolean, allowed: boolean) =>
    setTools((current) =>
      current.map((tool) =>
        changed(tool)
          ? { ...tool, granted: allowed, askFirst: tool.granted === allowed ? tool.askFirst : false }
          : tool,
      ),
    )
  const tool = async (name: string, allowed: boolean) => {
    await request('/api/mcp/grants', { method: 'PUT', body: { serverId, name, allowed } })
    grant((other) => other.name === name, allowed)
  }
  const app = async (uri: string, allowed: boolean) => {
    await request('/api/mcp/app-grants', { method: 'PUT', body: { serverId, uri, allowed } })
    grant((other) => other.appResource === uri, allowed)
  }
  const attempt = (busy: readonly string[], work: () => Promise<void>) =>
    void during(busy, () => work().catch((error: unknown) => onMessage(failureText(error))))
  return {
    pending,
    askFirst: (target: ToolView, enabled: boolean) =>
      attempt([target.name], async () => {
        await request('/api/mcp/ask-first', { method: 'PUT', body: { serverId, name: target.name, enabled } })
        setTools((current) =>
          current.map((item) => (item.name === target.name ? { ...item, askFirst: enabled } : item)),
        )
      }),
    toggle: (target: ToolView, allowed: boolean) => attempt([target.name], () => tool(target.name, allowed)),
    allowApp: (uri: string, allowed: boolean) =>
      attempt(names(tools.filter((each) => each.appResource === uri)), () => app(uri, allowed)),
    /** Every App, then every other tool, one grant at a time; it stops at the first refusal. */
    all: (allowed: boolean) => {
      const loose = tools.filter((each) => each.appResource === undefined && each.granted !== allowed)
      const apps = appsOf(tools).filter((uri) =>
        tools.some((each) => each.appResource === uri && each.granted !== allowed),
      )
      attempt(names(tools), async () => {
        for (const uri of apps) await app(uri, allowed)
        for (const each of loose) await tool(each.name, allowed)
      })
    },
  }
}

/** The server's tools, an App's tools grouped under it; grants change here and the list follows. */
export function ToolGrants({
  serverId,
  tools,
  setTools,
  onMessage,
}: {
  readonly serverId: string
  readonly tools: Tools
  readonly setTools: (update: (tools: Tools) => Tools) => void
  readonly onMessage: (message: string) => void
}) {
  const grants = useGrants(serverId, tools, setTools, onMessage)
  if (tools.length === 0) return <p className="server-note">This server offers no tools.</p>
  return (
    <section className="server-part" aria-label="Tools">
      <GrantsHead tools={tools} busy={grants.pending.size > 0} onAll={grants.all} />
      <ul className="grant-list">
        {appsOf(tools).map((uri) => (
          <AppGroup
            key={uri}
            serverId={serverId}
            uri={uri}
            tools={tools.filter((tool) => tool.appResource === uri)}
            pending={grants.pending}
            onAllow={(allowed) => grants.allowApp(uri, allowed)}
            onToggle={grants.toggle}
            onAskFirst={grants.askFirst}
          />
        ))}
        {tools
          .filter((tool) => tool.appResource === undefined)
          .map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              pending={grants.pending.has(tool.name)}
              onToggle={(allowed) => grants.toggle(tool, allowed)}
              onAskFirst={(enabled) => grants.askFirst(tool, enabled)}
            />
          ))}
      </ul>
      <p className="server-note">
        Your agent may call only the tools you allow. Ask first holds each call for your decision; remote hints do not
        choose that policy.
      </p>
    </section>
  )
}
