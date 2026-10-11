import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { PersonaAnswerData, type PersonaDefinition, type PersonaView, type RoutineDefinition } from '@goblin/contracts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { decide, heldIn } from './approvals-case.ts'
import { grantPlan, lever, person, signedIn, type Person } from './owner-requests.ts'
import { ownerSnapshot } from './probe-reads.ts'
import { until as untilWithin } from './until.ts'

const SERVER = 'apps-fixture'
const TOOL = 'board'

const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({
    entries: Schema.optional(
      Schema.Array(Schema.Struct({ id: Schema.Number, kind: Schema.String, data: Schema.optional(Schema.Unknown) })),
    ),
  }),
)
const decodeAnswer = Schema.decodeUnknownSync(PersonaAnswerData)
const decodeCalls = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.Unknown })))

/** As `until`, for up to 20 s: a Persona answers after its fork's turn, and again after the owner's reply. */
const until = <A>(read: () => Promise<A>, done: (value: A) => boolean) => untilWithin(read, done, 20_000)

/** The Persona answers in `chat` so far, oldest first. */
const answers = async (me: AgentFetch, chat = '1') =>
  (decodeEntries(await ownerSnapshot(me, chat)).entries ?? [])
    .filter((entry) => entry.kind === 'app.persona')
    .map((entry) => decodeAnswer(entry.data))

/** The calls the apps fixture ran. */
const calls = async (url: string, owner: Person) =>
  decodeCalls(await (await lever(url, owner, 'approvals/calls')).json())

/** A Persona that adds the apps fixture to its Topic's setup. */
const persona = (name: string): PersonaDefinition => ({
  name,
  avatar: { glyph: name.slice(0, 1), hue: 40 },
  role: `${name} on the board`,
  instructions: `Answer as ${name}.`,
  setup: { mcpServers: [{ connectionId: SERVER, tools: 'all' }], skills: [], apps: [] },
})

/** The owner's message into main tagging `tagged`, whose fork is scripted to call the board with `args`. */
const tag = (me: AgentFetch, tagged: PersonaView, args: object) =>
  callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: {
        input: `persona-call mcp_call ${JSON.stringify({ connectionId: SERVER, name: TOOL, arguments: args })}`,
        operationId: crypto.randomUUID(),
        selections: [{ kind: 'persona', personaId: tagged.id }],
      },
    }),
  )

/** A tagged Persona's ask-first call holds for the owner; their approval runs it once and the Persona answers again. */
async function approvalFromFork(url: string, owner: Person, me: AgentFetch, bidder: PersonaView) {
  await tag(me, bidder, { operationKey: 'persona-held' })
  const held = await until(
    () => answers(me),
    (found) => found.some((answer) => answer.persona === bidder.id && answer.hold?.kind === 'approval'),
  )
  const hold = held.find((answer) => answer.hold?.kind === 'approval')?.hold
  expect(hold).toMatchObject({ kind: 'approval', connectionId: SERVER, name: TOOL })
  expect(await calls(url, owner)).not.toContainEqual({ name: TOOL, args: { operationKey: 'persona-held' } })
  expect((await decide(me, hold?.approvalId ?? '', true)).state).toBe('completed')
  expect(await calls(url, owner)).toContainEqual({ name: TOOL, args: { operationKey: 'persona-held' } })
  const after = await until(
    () => answers(me),
    (found) => found.filter((answer) => answer.persona === bidder.id).length >= 2,
  )
  const next = after.filter((answer) => answer.persona === bidder.id).at(-1)
  expect(next?.hold).toBeUndefined()
  // The scripted fork echoes the decision's last line: the held call's result, as untrusted data.
  expect(next?.text).toContain('persona-held')
}

/** A tagged Persona's call to a tool not granted asks the owner to allow it; Allow and a reply let the Persona go on. */
async function grantFromFork(me: AgentFetch, bidder: PersonaView) {
  await callOwner(me, (api) => api.mcp.setToolGrant({ payload: { connectionId: SERVER, name: TOOL, allowed: false } }))
  const before = (await answers(me)).length
  await tag(me, bidder, { operationKey: 'persona-grant' })
  const asked = await until(
    () => answers(me),
    (found) => found.length > before && found.at(-1)?.hold?.kind === 'grant',
  )
  const hold = asked.at(-1)?.hold
  expect(hold).toMatchObject({ kind: 'grant', connectionId: SERVER, name: TOOL })
  await callOwner(me, (api) => api.mcp.setToolGrant({ payload: { connectionId: SERVER, name: TOOL, allowed: true } }))
  const operationId = crypto.randomUUID()
  const reply = { fork: hold?.fork ?? '', operationId, text: `Allowed ${SERVER} · ${TOOL}. Continue.` }
  await callOwner(me, (api) => api.personas.reply({ payload: reply }))
  const replied = await until(
    () => answers(me),
    (found) => found.length > asked.length,
  )
  expect(replied.at(-1)).toMatchObject({ persona: bidder.id, text: expect.stringContaining('Allowed') })
  expect(replied.at(-1)?.hold).toBeUndefined()
}

/** A routine handed to a Persona: its ask-first call waits for the owner, then the answer is the Persona's own. */
async function routineToPersona(url: string, owner: Person, me: AgentFetch, runner: PersonaView) {
  const definition: RoutineDefinition = {
    title: 'Board check',
    timezone: 'UTC',
    trigger: { kind: 'cron', expression: '0 9 * * *' },
    tellMe: { on: false, telegram: false },
    handTo: {
      kind: 'persona',
      persona: runner.id,
      revision: runner.revision,
      instruction: `call mcp_call ${JSON.stringify({ connectionId: SERVER, name: TOOL, arguments: { operationKey: 'routine-persona' } })}`,
      allowedTools: [{ connectionId: SERVER, name: TOOL }],
      budget: { tokensPerRun: 20_000, tokensPerDay: 40_000, runtimeSeconds: 120 },
    },
  }
  const draft = await callOwner(me, (api) =>
    api.routines.propose({ payload: { operationId: crypto.randomUUID(), topic: 1, definition } }),
  )
  await callOwner(me, (api) =>
    api.routines.confirm({ params: { id: draft.id }, payload: { revision: 1, operationId: crypto.randomUUID() } }),
  )
  const run = await callOwner(me, (api) =>
    api.routines.run({
      params: { id: draft.id },
      payload: { revision: 1, operationId: crypto.randomUUID(), confirmRun: true },
    }),
  )
  const waiting = await until(
    () => callOwner(me, (api) => api.routines.runs({ params: { id: draft.id } })),
    (page) => page.runs.some((each) => each.id === run.id && each.state === 'waiting_owner'),
  )
  const session = waiting.runs.find((each) => each.id === run.id)?.sessionId ?? ''
  expect((await decide(me, await heldIn(me, session), true)).state).toBe('completed')
  expect(await calls(url, owner)).toContainEqual({ name: TOOL, args: { operationKey: 'routine-persona' } })
  const reported = await until(
    () => answers(me),
    (found) => found.some((answer) => answer.routine?.run === run.id),
  )
  expect(reported.find((answer) => answer.routine?.run === run.id)).toMatchObject({
    persona: runner.id,
    name: 'Runner',
    revision: runner.revision,
    routine: { id: draft.id, run: run.id },
  })
}

/**
 * ADR 0041 in local workerd: a Persona's fork holds an ask-first call and a tool to allow for the owner, and the
 * owner's decision or reply resumes it; a routine handed to a Persona waits for an approval and answers as it.
 */
export async function personaHoldsCase(url: string): Promise<void> {
  const owner = await person(url)
  await grantPlan(url, owner)
  const me = signedIn(url, owner)
  await callOwner(me, (api) => api.mcp.connect({ params: { id: SERVER } }))
  await callOwner(me, (api) => api.mcp.setToolGrant({ payload: { connectionId: SERVER, name: TOOL, allowed: true } }))
  await callOwner(me, (api) => api.mcp.setAskFirst({ payload: { connectionId: SERVER, name: TOOL, enabled: true } }))
  const make = (definition: PersonaDefinition) =>
    callOwner(me, (api) => api.personas.create({ payload: { ...definition, operationId: crypto.randomUUID() } }))
  const bidder = await make(persona('Bidder'))
  await approvalFromFork(url, owner, me, bidder)
  await routineToPersona(url, owner, me, await make(persona('Runner')))
  await grantFromFork(me, bidder)
}
