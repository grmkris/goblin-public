import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import {
  ComposerOptions,
  ConversationView,
  OrganizeReceipt,
  PersonaDetail,
  PersonaView,
  TopicView,
  WorkspaceChange,
  type PersonaDefinition,
} from '@goblin/contracts'
import { call, ownerFetch, person, waitFor, type Person } from './owner-requests.ts'

const decodePersona = Schema.decodeUnknownSync(PersonaView)
const decodeDetail = Schema.decodeUnknownSync(PersonaDetail)
const decodeReceipts = Schema.decodeUnknownSync(Schema.Array(OrganizeReceipt))
const decodeReceipt = Schema.decodeUnknownSync(OrganizeReceipt)
const decodeTopics = Schema.decodeUnknownSync(Schema.Array(TopicView))
const decodeViews = Schema.decodeUnknownSync(Schema.Array(ConversationView))
const decodeOptions = Schema.decodeUnknownSync(ComposerOptions)
const decodeChanges = Schema.decodeUnknownSync(Schema.Array(WorkspaceChange))
const decodeSeen = Schema.decodeUnknownSync(
  Schema.Struct({
    requests: Schema.Array(
      Schema.Struct({
        messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
        systemPrompt: Schema.String,
        tools: Schema.Array(Schema.String),
        context: Schema.optional(Schema.String),
      }),
    ),
  }),
)
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({
    entries: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          kind: Schema.String,
          data: Schema.optional(Schema.Unknown),
          model: Schema.optional(
            Schema.Array(
              Schema.Struct({ role: Schema.optional(Schema.String), content: Schema.optional(Schema.Unknown) }),
            ),
          ),
        }),
      ),
    ),
  }),
)

const withBody = (method: 'PATCH' | 'POST', url: string, owner: Person, path: string, body: unknown) =>
  ownerFetch(`${url}${path}`, {
    method,
    headers: {
      cookie: owner.cookie,
      origin: 'https://goblin.test',
      'x-goblin-csrf': '1',
      'content-type': 'application/json',
      'cf-connecting-ip': owner.ip,
    },
    body: JSON.stringify(body),
  })
const patch = (url: string, owner: Person, path: string, body: unknown) => withBody('PATCH', url, owner, path, body)

const seen = async (url: string, owner: Person) =>
  decodeSeen(await (await call(url, owner, '/__test/queue/seen')).json()).requests
/** The requests a Persona's fork made: they carry its `<persona>` part in the context tail. */
const forkRequests = (requests: Awaited<ReturnType<typeof seen>>) =>
  requests.filter((request) => request.context?.includes('<persona>') === true)
const goblinRequests = (requests: Awaited<ReturnType<typeof seen>>) =>
  requests.filter((request) => request.context?.includes('<persona>') !== true)
const entries = async (url: string, owner: Person, chat = '1') =>
  decodeEntries(await (await call(url, owner, `/api/conversations/${chat}/snapshot`)).json()).entries ?? []
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
          .join('\n')
      : ''

async function until<A>(read: () => Promise<A>, done: (value: A) => boolean, ms = 15_000): Promise<A> {
  let value = await read()
  for (let attempt = 0; attempt < ms / 25 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = await read()
  }
  return value
}

/** The attributed answers in the chat so far, oldest first. */
const answers = async (url: string, owner: Person) =>
  (await entries(url, owner))
    .filter((entry) => entry.kind === 'app.persona')
    .map((entry) => {
      const data = Schema.decodeUnknownSync(
        Schema.Struct({
          persona: Schema.Number,
          name: Schema.String,
          revision: Schema.Number,
          operationId: Schema.String,
          text: Schema.String,
        }),
      )(entry.data)
      return { ...data, id: entry.id, model: textOf(entry.model?.[0]?.content) }
    })
const answersUntil = (url: string, owner: Person, count: number) =>
  until(
    () => answers(url, owner),
    (all) => all.length >= count,
  )
/** Answers by the Persona called `name`, once it has `count` of them. */
const answersBy = async (url: string, owner: Person, name: string, count: number) =>
  (
    await until(
      () => answers(url, owner),
      (all) => all.filter((answer) => answer.name === name).length >= count,
    )
  ).filter((answer) => answer.name === name)

const definition = (name: string, extra: Partial<PersonaDefinition> = {}): PersonaDefinition => ({
  name,
  avatar: { glyph: name.slice(0, 1), hue: 200 },
  role: `${name} the helper`,
  instructions: `Answer as ${name}.`,
  exclusions: [],
  ...extra,
})
async function makePersona(url: string, owner: Person, input: PersonaDefinition): Promise<PersonaView> {
  const response = await call(url, owner, '/api/personas', { ...input, operationId: crypto.randomUUID() })
  expect(response.status).toBe(201)
  return decodePersona(await response.json())
}
const send = (url: string, owner: Person, input: string, personas: readonly PersonaView[], extra: object = {}) => {
  const operationId = crypto.randomUUID()
  return call(url, owner, '/api/conversations/1/messages', {
    input,
    operationId,
    selections: personas.map((persona) => ({ kind: 'persona', personaId: persona.id })),
    ...extra,
  }).then((response) => ({ response, operationId }))
}
const ready = async (url: string): Promise<Person> => {
  const owner = await person(url)
  await call(url, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
  return owner
}

/** Registry routes: create once per operation, name clash, model, revisions with compare-and-set, composer options. */
async function registry(url: string, owner: Person): Promise<PersonaView> {
  const operationId = crypto.randomUUID()
  const input = { ...definition('Scout'), operationId }
  const first = await call(url, owner, '/api/personas', input)
  const again = await call(url, owner, '/api/personas', input)
  expect([first.status, again.status]).toEqual([201, 201])
  const scout = decodePersona(await first.json())
  expect(decodePersona(await again.json())).toEqual(scout)
  expect(scout).toMatchObject({ name: 'Scout', revision: 1 })
  expect(
    (await call(url, owner, '/api/personas', { ...definition('scout'), operationId: crypto.randomUUID() })).status,
  ).toBe(409)
  expect(
    (
      await call(url, owner, '/api/personas', {
        ...definition('Odd'),
        model: 'not-offered',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400)
  const edited = await patch(url, owner, `/api/personas/${scout.id}`, { role: 'Scouts ahead', expectedRevision: 1 })
  expect(edited.status).toBe(200)
  expect(decodePersona(await edited.json())).toMatchObject({ revision: 2, role: 'Scouts ahead' })
  expect((await patch(url, owner, `/api/personas/${scout.id}`, { role: 'Stale', expectedRevision: 1 })).status).toBe(
    409,
  )
  const detail = decodeDetail(await (await call(url, owner, `/api/personas/${scout.id}`)).json())
  expect(detail.revisions.map((each) => [each.revision, each.role])).toEqual([
    [2, 'Scouts ahead'],
    [1, 'Scout the helper'],
  ])
  const options = decodeOptions(await (await call(url, owner, '/api/conversations/1/composer')).json())
  expect(options.options.find((option) => option.selection.kind === 'persona')).toMatchObject({
    selection: { kind: 'persona', personaId: scout.id },
    label: 'Scout',
    description: 'Scouts ahead',
  })
  expect((await call(url, owner, '/api/personas/999')).status).toBe(404)
  return personaOf(url, owner, scout.id)
}

/**
 * Tagged Personas answer in the chat, attributed, and Goblin makes no model request at all. Parallel Personas do not see
 * each other; with "then" the second sees the first's answer. Their forks are hidden.
 */
async function asking(url: string, owner: Person, scout: PersonaView): Promise<void> {
  const critic = await makePersona(url, owner, definition('Critic'))
  const before = (await seen(url, owner)).length
  const { response, operationId } = await send(url, owner, 'weigh in on seeds', [scout, critic])
  expect(response.status).toBe(202)
  const both = await answersUntil(url, owner, 2)
  expect(both.map((answer) => answer.name).toSorted()).toEqual(['Critic', 'Scout'])
  expect(both.every((answer) => answer.operationId === operationId)).toBe(true)
  expect(both.find((answer) => answer.name === 'Scout')).toMatchObject({ revision: 2, persona: scout.id })
  expect(both.find((answer) => answer.name === 'Critic')?.model).toContain('[from persona Critic]')
  const requests = (await seen(url, owner)).slice(before)
  // Zero Goblin requests: only the two forks ever asked a model.
  expect(goblinRequests(requests)).toEqual([])
  expect(forkRequests(requests)).toHaveLength(2)
  const scoutRequest = forkRequests(requests).find((request) => request.context?.includes('You are Scout') === true)
  expect(scoutRequest?.context).toContain('Scouts ahead')
  expect(scoutRequest?.messages.map((message) => message.text).join('\n')).not.toContain('[from persona Critic]')
  const all = await entries(url, owner)
  const ask = all.find((entry) => entry.kind === 'app.persona_ask')
  expect(ask).toBeDefined()
  expect(textOf(ask?.model?.[0]?.content)).toBe('[to @Scout, @Critic] weigh in on seeds')
  expect(all.some((entry) => entry.kind === 'pi.assistant')).toBe(false)
  // The forks are hidden: the conversation list holds the chat alone.
  expect(decodeViews(await (await call(url, owner, '/api/conversations')).json()).map((view) => view.id)).toEqual(['1'])

  const first = await makePersona(url, owner, definition('First'))
  const second = await makePersona(url, owner, definition('Second'))
  const mark = (await seen(url, owner)).length
  const sequenced = await send(url, owner, 'one after the other', [first, second], { personaOrder: 'sequence' })
  expect(sequenced.response.status).toBe(202)
  await answersBy(url, owner, 'Second', 1)
  const ordered = (await answers(url, owner)).filter((answer) => answer.operationId === sequenced.operationId)
  expect(ordered.map((answer) => answer.name)).toEqual(['First', 'Second'])
  const forks = forkRequests((await seen(url, owner)).slice(mark))
  const textFor = (name: string) =>
    forks
      .find((request) => request.context?.includes(`You are ${name}`) === true)
      ?.messages.map((message) => message.text)
      .join('\n') ?? ''
  expect(textFor('First')).not.toContain('[from persona Second]')
  expect(textFor('Second')).toContain('[from persona First]')
  // An unknown or archived Persona refuses the whole send, and nothing is asked.
  const refused = await send(url, owner, 'nobody home', [{ ...first, id: 9999 }])
  expect(refused.response.status).toBe(400)
  await patch(url, owner, `/api/personas/${second.id}`, { archived: true, expectedRevision: 1 })
  expect((await send(url, owner, 'gone', [second])).response.status).toBe(400)
}

/** The fork's request starts with the chat's last request as Goblin made it: the same cacheable prefix. */
async function prefix(url: string, owner: Person): Promise<void> {
  const scout = await makePersona(url, owner, definition('Prefix'))
  expect(
    (
      await call(url, owner, '/api/conversations/1/messages', {
        input: 'hello prefix',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  await waitFor(url, owner, '/api/conversations/1/snapshot', 'echo: hello prefix')
  const parent = goblinRequests(await seen(url, owner)).at(-1)
  expect(parent).toBeDefined()
  await send(url, owner, 'now the persona', [scout])
  await answersBy(url, owner, 'Prefix', 1)
  const fork = forkRequests(await seen(url, owner)).at(-1)
  expect(fork?.messages.slice(0, parent?.messages.length ?? 0)).toEqual(parent?.messages)
  // What it adds after that prefix is the chat so far and the prompt; the Persona itself is in the tail.
  expect(fork?.context).toContain('You are Prefix')
  expect(fork?.tools).not.toContain('subagent_spawn')
}

/** A Persona edited while its answer is held keeps the revision it was asked at; the next ask uses the new one. */
async function revisions(url: string, owner: Person): Promise<void> {
  const drift = await makePersona(url, owner, definition('Drift', { instructions: 'Alpha rules.' }))
  const key = 'queue-hold:rev@Drift'
  await send(url, owner, 'queue-hold:rev', [drift])
  await waitFor(url, owner, '/__test/queue/held', key)
  const edit = await patch(url, owner, `/api/personas/${drift.id}`, {
    instructions: 'Beta rules.',
    expectedRevision: 1,
  })
  expect(decodePersona(await edit.json()).revision).toBe(2)
  const released = await call(url, owner, '/__test/queue/release', { input: key })
  expect(released.status).toBe(200)
  const [old] = await answersBy(url, owner, 'Drift', 1)
  expect(old?.revision).toBe(1)
  const held = forkRequests(await seen(url, owner)).filter(
    (request) => request.context?.includes('You are Drift') === true,
  )
  expect(held.at(-1)?.context).toContain('Alpha rules.')
  expect(held.at(-1)?.context).not.toContain('Beta rules.')
  await send(url, owner, 'again', [{ ...drift, revision: 2 }])
  const next = (await answersBy(url, owner, 'Drift', 2)).at(-1)
  expect(next?.revision).toBe(2)
  const latest = forkRequests(await seen(url, owner))
    .filter((request) => request.context?.includes('You are Drift') === true)
    .at(-1)
  expect(latest?.context).toContain('Beta rules.')
}

/** Reads the workspace feed in the background: every `change` event, until stopped. */
function watchFeed(url: string, owner: Person) {
  const controller = new AbortController()
  const changes: WorkspaceChange[] = []
  const done = (async () => {
    const response = await fetch(`${url}/api/workspace/events`, {
      headers: { cookie: owner.cookie, origin: 'https://goblin.test', 'cf-connecting-ip': owner.ip },
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    if (reader === undefined) return
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { value, done: finished } = await reader.read()
      if (finished) return
      buffered += decoder.decode(value, { stream: true })
      const frames = buffered.split('\n\n')
      buffered = frames.pop() ?? ''
      for (const frame of frames) {
        const data = /^data: (.*)$/mu.exec(frame)?.[1]
        if (frame.startsWith('event: change') && data !== undefined) changes.push(...decodeChanges(JSON.parse(data)))
      }
    }
  })().catch(() => undefined)
  return {
    changes,
    stop: async () => {
      controller.abort()
      await done
    },
  }
}

/** Stop drops the Personas still answering in the chat: their invocations end `stopped` and nothing is written. */
async function stopping(url: string, owner: Person): Promise<void> {
  const slow = await makePersona(url, owner, definition('Slow'))
  const slower = await makePersona(url, owner, definition('Slower'))
  const feed = watchFeed(url, owner)
  const written = (await answers(url, owner)).length
  await send(url, owner, 'queue-hold:stop', [slow, slower])
  await waitFor(url, owner, '/__test/queue/held', 'queue-hold:stop@Slow')
  await waitFor(url, owner, '/__test/queue/held', 'queue-hold:stop@Slower')
  const stop = await call(url, owner, '/api/conversations/1/stop', { operationId: crypto.randomUUID() })
  expect(stop.status).toBe(200)
  const stopped = await until(
    async () =>
      feed.changes.flatMap((change) =>
        change.type === 'invocation' && change.invocation.state === 'stopped' ? [change.invocation] : [],
      ),
    (all) => new Set(all.map((invocation) => invocation.persona)).size >= 2,
  )
  await feed.stop()
  expect(new Set(stopped.map((invocation) => invocation.persona))).toEqual(new Set([slow.id, slower.id]))
  expect((await answers(url, owner)).length).toBe(written)
  expect(await (await call(url, owner, '/__test/queue/held')).text()).not.toContain('queue-hold:stop')
}

/** A Persona's excluded server is off in its fork, as in any conversation that switched it off. */
async function exclusions(url: string, owner: Person): Promise<void> {
  const guard = await makePersona(
    url,
    owner,
    definition('Guard', { exclusions: [{ kind: 'server', serverId: 'apps-fixture' }] }),
  )
  const call_ = 'persona-call mcp_call {"serverId":"apps-fixture","name":"anything","arguments":{}}'
  await send(url, owner, call_, [guard])
  const answer = (
    await until(
      () => answers(url, owner),
      (all) => all.some((each) => each.name === 'Guard'),
    )
  ).find((each) => each.name === 'Guard')
  expect(answer?.text).toContain('Off in this conversation: apps-fixture')
  const request = forkRequests(await seen(url, owner))
    .filter((each) => each.context?.includes('You are Guard') === true)
    .at(0)
  expect(request?.tools).toEqual(expect.not.arrayContaining(['subagent_spawn', 'topic_create', 'persona_update']))
}

export async function personasCase(url: string): Promise<void> {
  const owner = await ready(url)
  const scout = await registry(url, owner)
  await asking(url, owner, scout)
  await prefix(url, owner)
  await revisions(url, owner)
  await stopping(url, owner)
  await exclusions(url, owner)
}

const ask = async (url: string, owner: Person, input: string, expected: string) => {
  const sent = await call(url, owner, '/api/conversations/1/messages', { input, operationId: crypto.randomUUID() })
  expect(sent.status).toBe(202)
  await waitFor(url, owner, '/api/conversations/1/snapshot', expected)
}
const receipts = async (url: string, owner: Person) =>
  decodeReceipts(await (await call(url, owner, '/api/organize')).json())
const newest = async (url: string, owner: Person) => (await receipts(url, owner))[0]
const undo = (url: string, owner: Person, id: string | undefined) =>
  call(url, owner, `/api/organize/${id ?? ''}/undo`, {})
const topics = async (url: string, owner: Person) => decodeTopics(await (await call(url, owner, '/api/topics')).json())
const personaOf = async (url: string, owner: Person, id: number | string) =>
  decodeDetail(await (await call(url, owner, `/api/personas/${String(id)}`)).json()).persona

/** Topics: the agent creates, renames and archives; Undo is refused after a later edit and applies once. */
async function organizingTopics(url: string, owner: Person): Promise<void> {
  await ask(url, owner, 'call topic_create {"name":"Orchard"}', 'Created topic')
  const created = await newest(url, owner)
  expect(created).toMatchObject({
    kind: 'topic.create',
    actor: 'agent',
    chat: '1',
    summary: 'Created topic "Orchard"',
    undoable: true,
  })
  const orchard = (await topics(url, owner)).find((topic) => topic.name === 'Orchard')
  expect(orchard).toMatchObject({ createdBy: 'agent', revision: 1 })
  await ask(url, owner, 'call topic_rename {"topic":"orchard","name":"Grove"}', 'Renamed topic')
  const list = await receipts(url, owner)
  const rename = list[0]
  expect(rename).toMatchObject({ kind: 'topic.rename', actor: 'agent', undoable: true })
  // The rename touched what the creation made: its Undo is refused, the rename's is not.
  expect(list.find((each) => each.id === created?.id)?.undoable).toBe(false)
  expect((await undo(url, owner, created?.id)).status).toBe(409)
  const undone = await undo(url, owner, rename?.id)
  expect(undone.status).toBe(200)
  expect(decodeReceipt(await undone.json()).undoneAt).toBeTypeOf('number')
  expect((await topics(url, owner)).find((topic) => topic.id === orchard?.id)?.name).toBe('Orchard')
  expect((await undo(url, owner, rename?.id)).status).toBe(409)
  // The owner's own UI change leaves an owner receipt.
  expect((await patch(url, owner, `/api/topics/${orchard?.id ?? 0}`, { name: 'Orchard Two' })).status).toBe(200)
  expect(await newest(url, owner)).toMatchObject({ kind: 'topic.rename', actor: 'owner', undoable: true })
  await ask(url, owner, 'call topic_archive {"topic":"Orchard Two"}', 'Archived topic')
  expect((await topics(url, owner)).find((topic) => topic.id === orchard?.id)?.archivedAt).toBeTypeOf('number')
  const archive = await newest(url, owner)
  expect(archive).toMatchObject({ kind: 'topic.archive', actor: 'agent' })
  expect((await undo(url, owner, archive?.id)).status).toBe(200)
  expect((await topics(url, owner)).find((topic) => topic.id === orchard?.id)?.archivedAt).toBeUndefined()
}

/** Personas: the agent creates and updates; a fork told to organize cannot, having no such tool. */
async function organizingPersonas(url: string, owner: Person): Promise<void> {
  const input = 'call persona_create {"name":"Scribe","role":"Writes","instructions":"Write well."}'
  await ask(url, owner, input, 'Created persona')
  const made = await newest(url, owner)
  expect(made).toMatchObject({ kind: 'persona.create', actor: 'agent', summary: 'Created persona @Scribe' })
  const scribe = await personaOf(url, owner, made?.target ?? 0)
  expect(scribe).toMatchObject({ name: 'Scribe', revision: 1, role: 'Writes' })
  await ask(url, owner, 'call persona_update {"persona":"Scribe","role":"Writes better"}', 'Updated persona')
  expect((await undo(url, owner, made?.id)).status).toBe(409)
  const edit = await newest(url, owner)
  expect(edit).toMatchObject({ kind: 'persona.update', actor: 'agent' })
  expect((await undo(url, owner, edit?.id)).status).toBe(200)
  expect(await personaOf(url, owner, scribe.id)).toMatchObject({ role: 'Writes', revision: 3 })
  await send(url, owner, 'persona-call topic_create {"name":"Sneaky"}', [scribe])
  await until(
    () => answers(url, owner),
    (all) => all.length >= 1,
  )
  expect((await topics(url, owner)).some((topic) => topic.name === 'Sneaky')).toBe(false)
}

/** Goblin organizes on request with receipts; Undo applies only while nothing touched the target since. */
export async function organizeCase(url: string): Promise<void> {
  const owner = await ready(url)
  await organizingTopics(url, owner)
  await organizingPersonas(url, owner)
}
