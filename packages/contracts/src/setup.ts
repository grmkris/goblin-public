import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

// A Topic's setup and a Persona's (ADR 0040): what a Topic's chats work with, and what a Persona adds there.

const ServerId = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
const ToolName = NonEmptyString(256)
/** A skill's name: the name of its directory, which stays when a new version changes its URI. */
const SkillName = NonEmptyString(128)
/** An agent app's name, as the app is stored. */
export const SetupAppName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,23}$/u))

/** Everything the owner allows in a category, including what they allow later, or only the items listed. */
const pick = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Union([Schema.Literal('all'), Schema.Array(item).check(Schema.isMaxLength(max))])

/** One MCP server in a setup: every tool the owner granted on it, or only these. */
export const SetupServer = Schema.Struct({
  serverId: ServerId,
  tools: pick(ToolName, 200),
})
export type SetupServer = typeof SetupServer.Type

/**
 * One skill server's skills in a setup: the whole library (no `name`) or one skill by name. `uri` is kept only when
 * two skills of the server share the name, to say which.
 */
export const SetupSkill = Schema.Struct({
  serverId: ServerId,
  name: Schema.optionalKey(SkillName),
  uri: Schema.optionalKey(NonEmptyString(2048)),
}).check(Schema.makeFilter((skill) => skill.uri === undefined || skill.name !== undefined))
export type SetupSkill = typeof SetupSkill.Type

/** What a Topic's chats work with: its MCP servers, skills, agent apps, and whether they may start subagents. */
export const TopicSetup = Schema.Struct({
  mcpServers: pick(SetupServer, 100),
  skills: pick(SetupSkill, 500),
  apps: pick(SetupAppName, 100),
  subagents: Schema.Boolean,
})
export type TopicSetup = typeof TopicSetup.Type

/** What a Persona adds to the setup of the Topic it answers in. It never starts subagents. */
export const PersonaSetup = Schema.Struct({
  mcpServers: TopicSetup.fields.mcpServers,
  skills: TopicSetup.fields.skills,
  apps: TopicSetup.fields.apps,
})
export type PersonaSetup = typeof PersonaSetup.Type

/** A Topic that works with everything the owner allows: every existing Topic's setup, and a new one's by default. */
export const EVERYTHING: TopicSetup = { mcpServers: 'all', skills: 'all', apps: 'all', subagents: true }

/** A Persona that adds nothing: it works with its Topic's setup. */
export const NOTHING: PersonaSetup = { mcpServers: [], skills: [], apps: [] }

/** One thing a setup can hold or a call can need: a server, one of its tools, a skills library, a skill, an app. */
export const SetupItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('server'), serverId: ServerId }),
  Schema.Struct({ kind: Schema.Literal('tool'), serverId: ServerId, name: ToolName }),
  Schema.Struct({ kind: Schema.Literal('library'), serverId: ServerId }),
  Schema.Struct({
    kind: Schema.Literal('skill'),
    serverId: ServerId,
    name: SkillName,
    uri: Schema.optionalKey(NonEmptyString(2048)),
  }),
  Schema.Struct({ kind: Schema.Literal('app'), app: SetupAppName }),
  Schema.Struct({ kind: Schema.Literal('subagents') }),
])
export type SetupItem = typeof SetupItem.Type
export const SetupItems = Schema.Array(SetupItem).check(Schema.isMinLength(1), Schema.isMaxLength(50))

/**
 * A refusal's details when a chat asked for something its Topic's setup does not hold (ADR 0040): what it asked for and
 * the Topic, which the owner can add it to. Only goblin's own results carry it (a remote result carries an `origin`).
 */
export const NotInTopic = Schema.Struct({
  kind: Schema.Literal('not-in-topic'),
  target: SetupItem,
  topic: Schema.Struct({ id: Schema.Int, name: Schema.String }),
})
export type NotInTopic = typeof NotInTopic.Type

/** What the owner allows now, by identity: what `withoutItems` lists when it narrows a category that was `all`. */
export type Allowed = {
  readonly servers: readonly { readonly serverId: string; readonly tools: readonly { readonly name: string }[] }[]
  readonly libraries: readonly {
    readonly serverId: string
    readonly skills: readonly { readonly name: string; readonly uri: string }[]
  }[]
  readonly apps: readonly { readonly name: string }[]
}

type Setup = TopicSetup | PersonaSetup

const serverOf = (setup: Setup, serverId: string) =>
  setup.mcpServers === 'all' ? undefined : setup.mcpServers.find((server) => server.serverId === serverId)

/** Whether `setup` holds the server: wholly or with some of its tools. */
export const hasServer = (setup: Setup, serverId: string): boolean =>
  setup.mcpServers === 'all' || serverOf(setup, serverId) !== undefined

/** Whether `setup` holds the server's tool. */
export const hasTool = (setup: Setup, serverId: string, name: string): boolean => {
  if (setup.mcpServers === 'all') return true
  const server = serverOf(setup, serverId)
  return server !== undefined && (server.tools === 'all' || server.tools.includes(name))
}

/** Whether `setup` holds any of the server's skills: the library or one of its skills. */
export const hasLibrary = (setup: Setup, serverId: string): boolean =>
  setup.skills === 'all' || setup.skills.some((skill) => skill.serverId === serverId)

/** Whether `setup` holds the skill: every skill, its whole library, or it by name (and URI, when one was kept). */
export const hasSkill = (setup: Setup, skill: { serverId: string; name: string; uri?: string }): boolean =>
  setup.skills === 'all' ||
  setup.skills.some(
    (held) =>
      held.serverId === skill.serverId &&
      (held.name === undefined || (held.name === skill.name && (held.uri === undefined || held.uri === skill.uri))),
  )

/** Whether `setup` holds the agent app. */
export const hasApp = (setup: Setup, app: string): boolean => setup.apps === 'all' || setup.apps.includes(app)

/** Whether `setup` holds `item`. A Persona's setup never holds subagents. */
export function holds(setup: Setup, item: SetupItem): boolean {
  switch (item.kind) {
    case 'server':
      return hasServer(setup, item.serverId)
    case 'tool':
      return hasTool(setup, item.serverId, item.name)
    case 'library':
      return hasLibrary(setup, item.serverId)
    case 'skill':
      return hasSkill(setup, item)
    case 'app':
      return hasApp(setup, item.app)
    case 'subagents':
      return 'subagents' in setup && setup.subagents
  }
}

/** `setup` with `item` added. Adding to a category that is `all` changes nothing. */
function withItem<S extends Setup>(setup: S, item: SetupItem): S {
  switch (item.kind) {
    case 'server':
    case 'tool': {
      if (setup.mcpServers === 'all') return setup
      const held = serverOf(setup, item.serverId)
      const rest = setup.mcpServers.filter((server) => server.serverId !== item.serverId)
      const tools: 'all' | readonly string[] =
        item.kind === 'server' || held?.tools === 'all' ? 'all' : [...new Set([...(held?.tools ?? []), item.name])]
      return { ...setup, mcpServers: [...rest, { serverId: item.serverId, tools }] }
    }
    case 'library': {
      if (setup.skills === 'all') return setup
      const rest = setup.skills.filter((skill) => skill.serverId !== item.serverId)
      return { ...setup, skills: [...rest, { serverId: item.serverId }] }
    }
    case 'skill': {
      if (setup.skills === 'all' || hasSkill(setup, item)) return setup
      const added: SetupSkill = {
        serverId: item.serverId,
        name: item.name,
        ...(item.uri === undefined ? {} : { uri: item.uri }),
      }
      return { ...setup, skills: [...setup.skills, added] }
    }
    case 'app':
      return setup.apps === 'all' || setup.apps.includes(item.app)
        ? setup
        : { ...setup, apps: [...setup.apps, item.app] }
    case 'subagents':
      return 'subagents' in setup ? { ...setup, subagents: true } : setup
  }
}

/** `setup` with every item added, in order. */
export const withItems = <S extends Setup>(setup: S, items: readonly SetupItem[]): S => items.reduce(withItem, setup)

/** The servers a setup holds, as a list: a category that held everything lists every server allowed now. */
const serverList = (setup: Setup, allowed: Allowed): readonly SetupServer[] =>
  setup.mcpServers === 'all' ? allowed.servers.map(({ serverId }) => ({ serverId, tools: 'all' })) : setup.mcpServers

/** The skills a setup holds, as a list: a category that held everything lists every library allowed now. */
const skillList = (setup: Setup, allowed: Allowed): readonly SetupSkill[] =>
  setup.skills === 'all' ? allowed.libraries.map(({ serverId }) => ({ serverId })) : setup.skills

/** A server's tools as a list: one that held all of them lists every tool allowed on it now. */
const toolsOf = (server: SetupServer, allowed: Allowed): readonly string[] => {
  if (server.tools !== 'all') return server.tools
  const now = allowed.servers.find((candidate) => candidate.serverId === server.serverId)
  return (now?.tools ?? []).map(({ name }) => name)
}

type ServerItem = Extract<SetupItem, { kind: 'server' | 'tool' }>
type SkillItem = Extract<SetupItem, { kind: 'skill' }>

/** The servers without a server, or without one tool of it (the server stays with its other tools). */
function serversWithout(setup: Setup, item: ServerItem, allowed: Allowed): readonly SetupServer[] {
  const servers = serverList(setup, allowed)
  const rest = servers.filter((server) => server.serverId !== item.serverId)
  const held = servers.find((server) => server.serverId === item.serverId)
  if (held === undefined || item.kind === 'server') return rest
  return [...rest, { serverId: item.serverId, tools: toolsOf(held, allowed).filter((name) => name !== item.name) }]
}

/**
 * The skills without one skill, named by server and name whichever URI an entry kept. A whole library that loses one
 * skill becomes each of its other skills allowed now, by name.
 */
function skillsWithout(setup: Setup, item: SkillItem, allowed: Allowed): readonly SetupSkill[] {
  const skills = skillList(setup, allowed)
  const ofServer = (skill: SetupSkill) => skill.serverId === item.serverId
  const whole = skills.some((skill) => ofServer(skill) && skill.name === undefined)
  const library = allowed.libraries.find((candidate) => candidate.serverId === item.serverId)
  const expanded = whole
    ? [
        ...skills.filter((skill) => !ofServer(skill)),
        ...(library?.skills ?? []).map(({ name }) => ({ serverId: item.serverId, name })),
      ]
    : skills
  return expanded.filter((skill) => !(ofServer(skill) && skill.name === item.name))
}

/** `setup` without `item`. Narrowing a category or library that holds everything lists what `allowed` has now. */
function withoutItem<S extends Setup>(setup: S, item: SetupItem, allowed: Allowed): S {
  switch (item.kind) {
    case 'server':
    case 'tool':
      return { ...setup, mcpServers: serversWithout(setup, item, allowed) }
    case 'library':
      return { ...setup, skills: skillList(setup, allowed).filter((skill) => skill.serverId !== item.serverId) }
    case 'skill':
      return { ...setup, skills: skillsWithout(setup, item, allowed) }
    case 'app': {
      const apps = setup.apps === 'all' ? allowed.apps.map(({ name }) => name) : setup.apps
      return { ...setup, apps: apps.filter((app) => app !== item.app) }
    }
    case 'subagents':
      return 'subagents' in setup ? { ...setup, subagents: false } : setup
  }
}

/** `setup` without any of `items`; `allowed` is what a category or library that held everything is narrowed from. */
export const withoutItems = <S extends Setup>(setup: S, items: readonly SetupItem[], allowed: Allowed): S =>
  items.reduce((current: S, item) => withoutItem(current, item, allowed), setup)

/** How an item reads to the owner and the model: `notes`, `notes · read`, `skills from lib`, `lib · review`, `app x`. */
export function itemLabel(item: SetupItem): string {
  switch (item.kind) {
    case 'server':
      return item.serverId
    case 'tool':
      return `${item.serverId} · ${item.name}`
    case 'library':
      return `skills from ${item.serverId}`
    case 'skill':
      return `${item.serverId} · ${item.name}`
    case 'app':
      return `app ${item.app}`
    case 'subagents':
      return 'subagents'
  }
}
