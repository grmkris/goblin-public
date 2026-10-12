// The tools a server offers and which of them the agent may call. Every switch is an exact owner grant for one tool
// (or, for an App, the App's resource and its tools). Names, descriptions and hints come from the server: they are
// shown as its claims and never grant anything.
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ToolView } from '@goblin/contracts'
import { NotFound } from '@goblin/contracts/api'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  NativeSelect,
  NativeSelectOption,
  Receipt,
  Switch,
} from '@goblin/ui'
import { CircleAlertIcon } from 'lucide-react'
import { appGrantMutation, askFirstMutation, refreshToolsMutation, toolGrantMutation } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
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
    <li>
      <Collapsible>
        <div className="grant-row">
          {/* The row opens to what the server says about the tool: its raw name, hints and whole description. */}
          <CollapsibleTrigger render={<button type="button" className="grant-text grant-toggle" />}>
            <span className="grant-name">
              <span id={id}>{tool.title ?? tool.name}</span>
              {tool.destructiveHint === true && <Badge variant="destructive">says destructive</Badge>}
            </span>
            {tool.description && <span className="grant-about">{tool.description}</span>}
          </CollapsibleTrigger>
          {tool.granted && (
            // A choice, never a toggle on a label: it shows the policy in force and changes only once the runtime has
            // the new one (the value follows the cache, so a refused change stays as it was).
            <NativeSelect
              size="sm"
              aria-label={`When ${tool.title ?? tool.name} is called`}
              value={tool.askFirst === true ? 'ask' : 'run'}
              disabled={pending}
              onChange={(event) => onAskFirst(event.target.value === 'ask')}
            >
              <NativeSelectOption value="run">Runs without asking</NativeSelectOption>
              <NativeSelectOption value="ask">Asks you first</NativeSelectOption>
            </NativeSelect>
          )}
          <Switch
            checked={tool.granted}
            disabled={pending}
            aria-busy={pending}
            aria-labelledby={id}
            onCheckedChange={(checked) => onToggle(checked)}
          />
        </div>
        <CollapsibleContent>
          <div className="grant-detail">
            <span className="grant-name">
              <code>{tool.name}</code>
              {tool.readOnlyHint === true && <Badge variant="outline">says read-only</Badge>}
              {!tool.modelVisible && <Badge variant="outline">App only</Badge>}
            </span>
            {tool.description && <p>{tool.description}</p>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** An App's name from its `ui://` resource: "ui://goblin-wallet/dashboard" is the Dashboard App. */
function appName(uri: string): string {
  const last =
    uri
      .replace(/^ui:\/\//u, '')
      .split('/')
      .findLast((part) => part !== '') ?? uri
  const words = last
    .replace(/\.[a-z]+$/u, '')
    .replaceAll(/[-_]+/gu, ' ')
    .trim()
  return words === '' ? 'Its App' : `${words.charAt(0).toUpperCase()}${words.slice(1)} App`
}

/**
 * An App and the exact tools it uses: one switch allows them all, and each stays listed and adjustable. A switch has
 * no middle state, so a group only partly allowed says how many of its tools are.
 */
function AppGroup({
  connectionId,
  uri,
  tools,
  pending,
  onAllow,
  onToggle,
  onAskFirst,
}: {
  readonly connectionId: string
  readonly uri: string
  readonly tools: Tools
  readonly pending: ReadonlySet<string>
  readonly onAllow: (allowed: boolean) => void
  readonly onToggle: (tool: ToolView, allowed: boolean) => void
  readonly onAskFirst: (tool: ToolView, enabled: boolean) => void
}) {
  const id = useId()
  const granted = tools.filter((tool) => tool.granted).length
  const partly = granted > 0 && granted < tools.length
  return (
    <li className="grant-app">
      <div className="grant-row">
        <AppTile origin={connectionId} />
        <span className="grant-text">
          <span id={id} className="grant-name">
            {appName(uri)}
          </span>
          <code className="grant-about">{uri}</code>
        </span>
        {partly && (
          <span id={`${id}-count`} className="grant-count">
            {`${granted} of ${tools.length} allowed`}
          </span>
        )}
        <Switch
          checked={granted === tools.length}
          disabled={tools.some((tool) => pending.has(tool.name))}
          aria-labelledby={id}
          {...(partly ? { 'aria-describedby': `${id}-count` } : {})}
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

/**
 * The tools outside an App, by what the server says they do. The headings are its claims: grouping is how the list
 * reads, never what it allows.
 */
export function purposeGroups(tools: Tools): readonly { readonly title: string; readonly members: Tools }[] {
  const loose = tools.filter((tool) => tool.appResource === undefined)
  const reads = loose.filter((tool) => tool.readOnlyHint === true)
  const rest = loose.filter((tool) => tool.readOnlyHint !== true)
  return [
    { title: 'The server says these only read', members: reads },
    { title: 'These may change things or spend', members: rest },
  ].filter((group) => group.members.length > 0)
}

const appsOf = (tools: Tools): readonly string[] => [
  ...new Set(tools.flatMap((tool) => (tool.appResource === undefined ? [] : [tool.appResource]))),
]

/** What the last change to a server's tools said: how Allow all went, or why a switch did not change. */
type Note = { readonly tone: 'neutral' | 'error'; readonly text: string }

/** Whole-server copy: "Allowed 57", with how many the server no longer offers. */
const allNote = (allowed: boolean, changed: number, gone: number): Note => {
  const done = `${allowed ? 'Allowed' : 'Turned off'} ${String(changed)}`
  return {
    tone: 'neutral',
    text: gone === 0 ? `${done}.` : `${done} · ${String(gone)} no longer offered by the server.`,
  }
}

/** One grant of a whole-server change: true when it changed, false when the server no longer offers it. */
const offered = (grant: Promise<unknown>) =>
  grant.then(
    () => true,
    (error: unknown) => {
      if (error instanceof NotFound) return false
      throw error
    },
  )

/** The grant calls behind the switches; each updates the list in the cache once the runtime has it. */
function useGrants(connectionId: string, tools: Tools, onNote: (note: Note | undefined) => void) {
  const { pending, during } = usePending()
  const toolGrant = useMutation(toolGrantMutation)
  const appGrant = useMutation(appGrantMutation)
  const askFirst = useMutation(askFirstMutation)
  const refresh = useMutation(refreshToolsMutation)
  const tool = (name: string, allowed: boolean) => toolGrant.mutateAsync({ connectionId, name, allowed })
  const app = (uri: string, allowed: boolean) => appGrant.mutateAsync({ connectionId, uri, allowed })
  const attempt = (busy: readonly string[], action: string, work: () => Promise<unknown>) =>
    void during(busy, () => {
      onNote(undefined)
      return work().then(
        () => undefined,
        (error: unknown) => onNote({ tone: 'error', text: messageOf(error, action) }),
      )
    })
  return {
    pending,
    askFirst: (target: ToolView, enabled: boolean) =>
      attempt([target.name], `change whether ${target.name} asks first`, () =>
        askFirst.mutateAsync({ connectionId, name: target.name, enabled }),
      ),
    toggle: (target: ToolView, allowed: boolean) =>
      attempt([target.name], `change ${target.name}`, () => tool(target.name, allowed)),
    allowApp: (uri: string, allowed: boolean) =>
      attempt(names(tools.filter((each) => each.appResource === uri)), 'change that App', () => app(uri, allowed)),
    /**
     * Every App, then every other tool, one grant at a time. A tool or App the server no longer offers is skipped and
     * counted (the list shown may be older than the server's); any other refusal stops. The list is read again after.
     */
    all: (allowed: boolean) => {
      const loose = tools.filter((each) => each.appResource === undefined && each.granted !== allowed)
      const apps = appsOf(tools).filter((uri) =>
        tools.some((each) => each.appResource === uri && each.granted !== allowed),
      )
      attempt(names(tools), allowed ? 'allow every tool' : 'turn every tool off', async () => {
        let changed = 0
        let gone = 0
        const count = (done: boolean, size: number) => {
          if (done) changed += size
          else gone += size
        }
        for (const uri of apps)
          count(await offered(app(uri, allowed)), tools.filter((each) => each.appResource === uri).length)
        for (const each of loose) count(await offered(tool(each.name, allowed)), 1)
        await refresh.mutateAsync(connectionId)
        onNote(allNote(allowed, changed, gone))
      })
    },
  }
}

/** The server's tools, an App's tools grouped under it; grants change here and the list follows. */
export function ToolGrants({ connectionId, tools }: { readonly connectionId: string; readonly tools: Tools }) {
  const [note, setNote] = useState<Note>()
  const grants = useGrants(connectionId, tools, setNote)
  if (tools.length === 0) return <p className="server-note">This server offers no tools.</p>
  return (
    <section className="server-part" aria-label="Tools">
      <GrantsHead tools={tools} busy={grants.pending.size > 0} onAll={grants.all} />
      {note !== undefined && (
        <Receipt tone={note.tone}>
          {note.tone === 'error' && <CircleAlertIcon aria-hidden />}
          <span>{note.text}</span>
        </Receipt>
      )}
      {appsOf(tools).length > 0 && (
        <ul className="grant-list">
          {appsOf(tools).map((uri) => (
            <AppGroup
              key={uri}
              connectionId={connectionId}
              uri={uri}
              tools={tools.filter((tool) => tool.appResource === uri)}
              pending={grants.pending}
              onAllow={(allowed) => grants.allowApp(uri, allowed)}
              onToggle={grants.toggle}
              onAskFirst={grants.askFirst}
            />
          ))}
        </ul>
      )}
      {purposeGroups(tools).map(({ title, members }) => (
        <div key={title} className="grant-group">
          <h4 className="grant-group-title">{title}</h4>
          <ul className="grant-list">
            {members.map((tool) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                pending={grants.pending.has(tool.name)}
                onToggle={(allowed) => grants.toggle(tool, allowed)}
                onAskFirst={(enabled) => grants.askFirst(tool, enabled)}
              />
            ))}
          </ul>
        </div>
      ))}
      <p className="server-note">
        Your agent may call only the tools you allow. Ask first holds each call for your decision; remote hints do not
        choose that policy.
      </p>
    </section>
  )
}
