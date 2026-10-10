import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { CapabilityChange, ConversationCapabilities } from '@goblin/contracts'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Switch,
} from '@goblin/ui'
import { ChevronRightIcon, SlidersHorizontalIcon } from 'lucide-react'
import { capabilityCount, serverState } from '../lib/capabilities.ts'
import { capabilitiesQuery, setCapabilityMutation } from '../capabilities/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'

type View = ConversationCapabilities
type Change = (change: CapabilityChange) => void

/**
 * A conversation's switches: loaded with it, again when a run starts or ends there (a card may have turned one on; the
 * workspace feed says so, `lib/workspace/invalidations.ts`) and when the panel opens. A change shows at once and is
 * replaced by the agent's answer, or undone with the reason.
 */
export function useCapabilities(thread: string) {
  const queryClient = useQueryClient()
  const read = useQuery(capabilitiesQuery(thread))
  const setting = useMutation(setCapabilityMutation(queryClient, thread))
  const { refetch } = read
  const load = useCallback(() => void refetch(), [refetch])
  const error =
    (setting.error !== null && messageOf(setting.error, 'change that switch')) ||
    (read.error !== null && messageOf(read.error, "read this conversation's switches")) ||
    ''
  const { mutate } = setting
  const change = useCallback((next: CapabilityChange) => mutate(next), [mutate])
  return { view: read.data, error, change, load }
}

/** One switch with its name; the whole row toggles it, at least 44px tall on touch screens. */
function SwitchRow({
  label,
  detail,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string
  readonly detail?: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <label className="capability-row" data-disabled={disabled || undefined}>
      <span className="capability-name">
        <span className="truncate">{label}</span>
        {detail !== undefined && <span className="capability-detail">{detail}</span>}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  )
}

const STATE_TEXT = { on: 'All tools', some: 'Some tools', off: 'Off' } as const

/** A connection: its switch, and its granted tools behind a disclosure, each with its own switch. */
function ServerRow({ server, onChange }: { readonly server: View['servers'][number]; readonly onChange: Change }) {
  const { serverId } = server
  const state = serverState(server)
  return (
    <Collapsible>
      <div className="capability-row">
        <CollapsibleTrigger
          render={<button type="button" className="capability-expand" aria-label={`${server.label}: show its tools`} />}
        >
          <ChevronRightIcon aria-hidden />
          <span className="capability-name">
            <span className="truncate">{server.label}</span>
            <span className="capability-detail" data-state={state}>
              {state === 'some'
                ? `${server.tools.filter((tool) => tool.on).length} of ${server.tools.length} tools`
                : STATE_TEXT[state]}
            </span>
          </span>
        </CollapsibleTrigger>
        <Switch
          checked={server.on}
          aria-label={`Use ${server.label} here`}
          onCheckedChange={(on) => onChange({ target: { kind: 'server', serverId }, on })}
        />
      </div>
      <CollapsibleContent>
        <div className="capability-tools">
          {server.tools.map((tool) => (
            <SwitchRow
              key={tool.name}
              label={tool.title ?? tool.name}
              checked={tool.on}
              disabled={!server.on}
              onChange={(on) => onChange({ target: { kind: 'tool', serverId, name: tool.name }, on })}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Connections, Skills and Subagents, then Reset on a thread or a word on who else talks in main. */
function CapabilitiesPanel({
  view,
  error,
  onChange,
}: {
  readonly view: View
  readonly error: string
  readonly onChange: Change
}) {
  const main = view.kind === 'main'
  return (
    <>
      <div className="capability-header">
        <PopoverHeader>
          <PopoverTitle>What the agent can use here</PopoverTitle>
          <PopoverDescription>
            {main
              ? 'In main. Telegram and connected MCP clients talk here too, so this applies to them.'
              : "In this thread only. It started with main's setup."}
          </PopoverDescription>
        </PopoverHeader>
      </div>
      <section className="capability-section" aria-label="Connections">
        <h3 className="capability-heading">Connections</h3>
        {view.servers.length === 0 ? (
          <p className="capability-empty">
            No tools granted yet. <Link to="/connections">Grant some under Connections.</Link>
          </p>
        ) : (
          view.servers.map((server) => <ServerRow key={server.serverId} server={server} onChange={onChange} />)
        )}
      </section>
      {view.skills.length > 0 && (
        <section className="capability-section" aria-label="Skills">
          <h3 className="capability-heading">Skills</h3>
          {view.skills.map((library) => (
            <SwitchRow
              key={library.serverId}
              label={library.label}
              checked={library.on}
              onChange={(on) => onChange({ target: { kind: 'skills', serverId: library.serverId }, on })}
            />
          ))}
        </section>
      )}
      <section className="capability-section" aria-label="Subagents">
        <h3 className="capability-heading">Subagents</h3>
        <SwitchRow
          label="Start subagents"
          detail="Background helpers with the same tools"
          checked={view.subagents}
          onChange={(on) => onChange({ target: { kind: 'subagents' }, on })}
        />
      </section>
      {error !== '' && <p className="capability-error">{error}</p>}
      {!main && (
        <Button
          type="button"
          variant="ghost"
          disabled={view.sameAsParent === true}
          onClick={() => onChange({ reset: 'parent' })}
        >
          Reset to where it came from
        </Button>
      )}
    </>
  )
}

/**
 * Beside the composer: what this conversation lets its agent use, in a panel above it. The button reads "3 of 5" when
 * something is switched off here. A subagent follows the conversation that started it, so it has none.
 */
export function CapabilitiesButton({ thread }: { readonly thread: string }) {
  const { view, error, change, load } = useCapabilities(thread)
  if (view === undefined || view.kind === 'subagent') return null
  const { on, total } = capabilityCount(view)
  const narrowed = on < total
  const summary = narrowed ? `${on} of ${total} on` : 'everything on'
  return (
    <Popover onOpenChange={(open) => open && load()}>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" aria-label={`What the agent can use here: ${summary}`} />}
      >
        <SlidersHorizontalIcon />
        {narrowed && (
          <span className="tabular-nums">
            {on} of {total}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" size="panel">
        <CapabilitiesPanel view={view} error={error} onChange={change} />
      </PopoverContent>
    </Popover>
  )
}
