import { type ReactNode, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { SetupCatalog, SetupItem } from '@goblin/contracts'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@goblin/ui'
import { ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { holds } from '@goblin/contracts'
import {
  type Category,
  type Setup,
  everything,
  holdsEverything,
  libraryHold,
  onlyThese,
  serverHold,
  switched,
  unavailableIn,
} from '../lib/setup.ts'

/** A library with more skills than this offers a filter over them. */
const FILTER_FROM = 8

type Change<S extends Setup> = (setup: S) => void

/** One switch with its name; the whole row toggles it, at least 44px tall on touch screens. */
function SwitchRow({
  label,
  detail,
  checked,
  onChange,
}: {
  readonly label: string
  readonly detail?: string | undefined
  readonly checked: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <label className="switch-row">
      <span className="switch-name">
        <span className="truncate">{label}</span>
        {detail !== undefined && <span className="switch-detail">{detail}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

/** A row that opens to its parts (a server's tools, a library's skills), with the switch for the whole of it. */
function GroupRow({
  label,
  detail,
  state,
  checked,
  onChange,
  children,
}: {
  readonly label: string
  readonly detail: string
  readonly state: 'all' | 'some' | 'none'
  readonly checked: boolean
  readonly onChange: (on: boolean) => void
  readonly children: ReactNode
}) {
  return (
    <Collapsible>
      <div className="switch-row">
        <CollapsibleTrigger
          render={<button type="button" className="switch-expand" aria-label={`${label}: show what it has`} />}
        >
          <ChevronRightIcon aria-hidden />
          <span className="switch-name">
            <span className="truncate">{label}</span>
            <span className="switch-detail" data-state={state}>
              {detail}
            </span>
          </span>
        </CollapsibleTrigger>
        <Switch checked={checked} aria-label={`Use ${label}`} onCheckedChange={onChange} />
      </div>
      <CollapsibleContent>
        <div className="switch-children">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A category's heading with its choice: everything the owner allows (now and later), or only the items chosen below.
 * Switching to "Only these" starts with everything that is there now, so nothing disappears until it is switched off.
 */
function CategoryHeading<S extends Setup>({
  title,
  category,
  setup,
  catalog,
  onChange,
}: {
  readonly title: string
  readonly category: Category
  readonly setup: S
  readonly catalog: SetupCatalog
  readonly onChange: Change<S>
}) {
  return (
    <div className="setup-category">
      <h3 className="setup-heading">{title}</h3>
      <Tabs
        value={holdsEverything(setup, category) ? 'all' : 'only'}
        onValueChange={(value) =>
          onChange(value === 'all' ? everything(setup, category) : onlyThese(setup, category, catalog))
        }
      >
        <TabsList aria-label={`${title}: everything or only these`}>
          <TabsTrigger value="all">Everything</TabsTrigger>
          <TabsTrigger value="only">Only these</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}

/** Says a category holds everything: what is here now, and what the owner adds later. */
function Everything({ children }: { readonly children: ReactNode }) {
  return <p className="setup-empty">{children}</p>
}

type Section<S extends Setup> = {
  readonly setup: S
  readonly catalog: SetupCatalog
  readonly onChange: Change<S>
}

/** MCP servers: each with its granted tools, all of them or some. */
function ServersSection<S extends Setup>({ setup, catalog, onChange }: Section<S>) {
  const toggle = (item: SetupItem, on: boolean) => onChange(switched(setup, item, on, catalog))
  return (
    <section className="setup-section" aria-label="MCP servers">
      <CategoryHeading title="MCP servers" category="mcpServers" setup={setup} catalog={catalog} onChange={onChange} />
      {catalog.servers.length === 0 ? (
        <p className="setup-empty">
          No tools granted yet. <Link to="/connections">Grant some under Connections.</Link>
        </p>
      ) : holdsEverything(setup, 'mcpServers') ? (
        <Everything>Every server and tool you grant, now and later.</Everything>
      ) : (
        catalog.servers.map((server) => {
          const state = serverHold(setup, server)
          const held = server.tools.filter(({ name }) =>
            holds(setup, { kind: 'tool', connectionId: server.connectionId, name }),
          ).length
          return (
            <GroupRow
              key={server.connectionId}
              label={server.label}
              state={state}
              detail={
                state === 'some'
                  ? `${String(held)} of ${String(server.tools.length)} tools`
                  : state === 'all'
                    ? 'All tools'
                    : 'Off'
              }
              checked={state !== 'none'}
              onChange={(on) => toggle({ kind: 'server', connectionId: server.connectionId }, on)}
            >
              {server.tools.map((tool) => (
                <SwitchRow
                  key={tool.name}
                  label={tool.title ?? tool.name}
                  checked={holds(setup, { kind: 'tool', connectionId: server.connectionId, name: tool.name })}
                  onChange={(on) => toggle({ kind: 'tool', connectionId: server.connectionId, name: tool.name }, on)}
                />
              ))}
            </GroupRow>
          )
        })
      )}
    </section>
  )
}

/** One library's skills, with a filter when there are many. */
function LibrarySkills<S extends Setup>({
  library,
  setup,
  catalog,
  onChange,
}: Section<S> & { readonly library: SetupCatalog['libraries'][number] }) {
  const [filter, setFilter] = useState('')
  const wanted = filter.trim().toLowerCase()
  const shown = library.skills.filter(
    (skill) => wanted === '' || `${skill.name} ${skill.description}`.toLowerCase().includes(wanted),
  )
  return (
    <>
      {library.skills.length > FILTER_FROM && (
        <div className="setup-filter">
          <Input
            value={filter}
            placeholder={`Filter ${String(library.skills.length)} skills`}
            aria-label={`Filter the skills of ${library.label}`}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}
      {!library.available && <p className="setup-empty">Its skills cannot be read right now.</p>}
      {shown.map((skill) => {
        const item: SetupItem = { kind: 'skill', connectionId: library.connectionId, name: skill.name }
        return (
          <SwitchRow
            key={skill.uri}
            label={skill.name}
            detail={skill.description === '' ? undefined : skill.description}
            checked={holds(setup, item)}
            onChange={(on) => onChange(switched(setup, item, on, catalog))}
          />
        )
      })}
    </>
  )
}

/** Skills: each library whole, or some of its skills by name (a new version keeps its place). */
function SkillsSection<S extends Setup>({ setup, catalog, onChange }: Section<S>) {
  if (catalog.libraries.length === 0) return null
  return (
    <section className="setup-section" aria-label="Skills">
      <CategoryHeading title="Skills" category="skills" setup={setup} catalog={catalog} onChange={onChange} />
      {holdsEverything(setup, 'skills') ? (
        <Everything>Every skill of the servers you turn skills on for, now and later.</Everything>
      ) : (
        catalog.libraries.map((library) => {
          const state = libraryHold(setup, library)
          return (
            <GroupRow
              key={library.connectionId}
              label={library.label}
              state={state}
              detail={state === 'all' ? 'Every skill' : state === 'some' ? 'Some skills' : 'Off'}
              checked={state !== 'none'}
              onChange={(on) =>
                onChange(switched(setup, { kind: 'library', connectionId: library.connectionId }, on, catalog))
              }
            >
              <LibrarySkills library={library} setup={setup} catalog={catalog} onChange={onChange} />
            </GroupRow>
          )
        })
      )}
    </section>
  )
}

/** Agent apps: each by name. */
function AppsSection<S extends Setup>({ setup, catalog, onChange }: Section<S>) {
  if (catalog.apps.length === 0) return null
  return (
    <section className="setup-section" aria-label="Apps">
      <CategoryHeading title="Apps" category="apps" setup={setup} catalog={catalog} onChange={onChange} />
      {holdsEverything(setup, 'apps') ? (
        <Everything>Every app your agent has built, now and later.</Everything>
      ) : (
        catalog.apps.map((app) => (
          <SwitchRow
            key={app.name}
            label={app.title}
            detail={app.name}
            checked={holds(setup, { kind: 'app', app: app.name })}
            onChange={(on) => onChange(switched(setup, { kind: 'app', app: app.name }, on, catalog))}
          />
        ))
      )}
    </section>
  )
}

/** What the setup lists that cannot be chosen now: it stays, grants nothing, and can be removed. */
function UnavailableSection<S extends Setup>({ setup, catalog, onChange }: Section<S>) {
  const gone = unavailableIn(setup, catalog)
  if (gone.length === 0) return null
  return (
    <section className="setup-section" aria-label="Unavailable">
      <h3 className="setup-heading">Unavailable</h3>
      {gone.map(({ item, label, reason }) => (
        <div key={label} className="switch-row" data-disabled>
          <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="switch-name">
            <span className="truncate">{label}</span>
            <span className="switch-detail">{reason}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(switched(setup, item, false, catalog))}
          >
            Remove
          </Button>
        </div>
      ))}
    </section>
  )
}

/**
 * What a Topic works with, or what a Persona adds (ADR 0040): its MCP servers and their tools, skills and apps, each
 * everything the owner allows or only the items chosen, and for a Topic whether it may start subagents. It edits a
 * draft; the editor around it saves it. Labels come from the servers and apps, display data only.
 */
export function SetupPicker<S extends Setup>({
  setup,
  catalog,
  onChange,
}: {
  readonly setup: S
  readonly catalog: SetupCatalog
  readonly onChange: Change<S>
}) {
  return (
    <div className="setup-picker">
      <ServersSection setup={setup} catalog={catalog} onChange={onChange} />
      <SkillsSection setup={setup} catalog={catalog} onChange={onChange} />
      <AppsSection setup={setup} catalog={catalog} onChange={onChange} />
      {'subagents' in setup && (
        <section className="setup-section" aria-label="Subagents">
          <h3 className="setup-heading">Subagents</h3>
          <SwitchRow
            label="Start subagents"
            detail="Background helpers that work with this setup"
            checked={setup.subagents}
            onChange={(on) => onChange({ ...setup, subagents: on })}
          />
        </section>
      )}
      <UnavailableSection setup={setup} catalog={catalog} onChange={onChange} />
    </div>
  )
}
