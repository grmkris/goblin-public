import { PRIMARY_CHAT } from '@goblin/contracts'
import { FlowRecord, InspectDetails } from '@goblin/contracts/inspect'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { exchange, ownerSend, snapshotOf, transcript, until } from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

const ASK = 'flows-ask'
const SPAWN = 'flows-spawn'

/** One query of the agent's own `/inspect` route, answered as its `{ ok, value }` result. */
const inspect = async (agent: Probe, query: object): Promise<unknown> =>
  (await agent.fetch(new Request('https://agent/inspect', { method: 'POST', body: JSON.stringify(query) }))).json()

/**
 * The flows a Persona and a Delegate leave (plan §4): the owner tags a Persona in main and it answers; main spawns a
 * subagent, which reports. Then the run ledger's flow rows, and the details of the ask and of the spawn's turn.
 */
export async function delegationFlowsSequence(agent: Probe): Promise<Response> {
  const scout = await callOwner(agent, (api) =>
    api.personas.create({
      payload: {
        name: 'Scout',
        avatar: { glyph: 'S', hue: 120 },
        role: 'Finds things out',
        instructions: 'Be brief.',
        exclusions: [],
        operationId: 'flows-persona',
      },
    }),
  )
  await ownerSend(agent, PRIMARY_CHAT, 'what is out there?', ASK, {
    selections: [{ kind: 'persona', personaId: scout.id }],
  })
  await until(
    async () => (await snapshotOf(agent, PRIMARY_CHAT)).entries ?? [],
    (entries) => entries.some((entry) => entry.kind === 'app.persona'),
    15_000,
  )
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'digger', message: 'dig' })}`
  await exchange(agent, PRIMARY_CHAT, spawn, SPAWN)
  await until(
    () => transcript(agent, PRIMARY_CHAT),
    (lines) => lines.some((line) => line.includes('[from subagent digger]')),
    20_000,
  )
  const flows = await until(
    () => inspect(agent, { kind: 'flows', chat: PRIMARY_CHAT }),
    (result) => JSON.stringify(result).includes('subagent_report'),
  )
  return Response.json({
    flows,
    askDetails: await inspect(agent, { kind: 'details', operation: ASK }),
    spawnDetails: await inspect(agent, { kind: 'details', operation: SPAWN }),
  })
}

const Ok = <S extends Schema.Top>(value: S) => Schema.Struct({ ok: Schema.Literal(true), value })
const DelegationFlowsRun = Schema.Struct({
  flows: Ok(Schema.Struct({ flows: Schema.Array(FlowRecord) })),
  askDetails: Schema.Unknown,
  spawnDetails: Schema.Unknown,
})
const decodeDetails = Schema.decodeUnknownSync(Ok(InspectDetails))

/** The sequence on a fresh agent `name` of the native worker at `base`, decoded. */
const run = async (base: string, name: string) =>
  Schema.decodeUnknownPromise(DelegationFlowsRun)(
    await (await fetch(`${base}/delegation-flows?name=${name}`, { headers: { connection: 'close' } })).json(),
  )

/**
 * A Persona's answer and a Delegate's spawn and report are each one content-free flow row in main: the answer with the
 * ask's order, the spawn by the agent's tool, the report by the subagent. Both name the turn that called the tool as
 * the operation that caused them.
 */
function flowChecks(result: typeof DelegationFlowsRun.Type): void {
  const flows = result.flows.value.flows
  expect(flows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        flow: 'persona_answer',
        via: 'system',
        actor: 'persona',
        chat: PRIMARY_CHAT,
        operationId: ASK,
        personaOrder: 'parallel',
        status: 'ok',
      }),
      expect.objectContaining({
        flow: 'subagent_spawn',
        via: 'tool',
        actor: 'agent',
        chat: PRIMARY_CHAT,
        parentOperation: SPAWN,
        synthesize: false,
        status: 'ok',
      }),
      expect.objectContaining({
        flow: 'subagent_report',
        via: 'system',
        actor: 'subagent',
        chat: PRIMARY_CHAT,
        operationId: expect.stringMatching(/^subagent-report:/u),
        parentOperation: SPAWN,
        synthesize: false,
        status: 'ok',
      }),
    ]),
  )
  // One answer, one spawn and one report: none is recorded twice.
  for (const flow of ['persona_answer', 'subagent_spawn', 'subagent_report'])
    expect(flows.filter((each) => each.flow === flow)).toHaveLength(1)
  expect(JSON.stringify(flows)).not.toContain('what is out there')
}

/**
 * The details of the owner's ask name the Persona's turn among its related operations, and those of main's turn that
 * spawned the subagent name the subagent's report (lane O's details reader over lane C's operation receipts).
 */
function detailChecks(result: typeof DelegationFlowsRun.Type): void {
  const ask = decodeDetails(result.askDetails).value
  expect(ask.related).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: expect.stringMatching(new RegExp(`^persona:${ASK}:`, 'u')) }),
    ]),
  )
  const spawn = decodeDetails(result.spawnDetails).value
  expect(spawn.related).toEqual(
    expect.arrayContaining([expect.objectContaining({ operation: expect.stringMatching(/^subagent-report:/u) })]),
  )
}

/** The flow rows first, then the details (which need lanes C and O as well). */
export async function delegationChecks(base: string, name: string): Promise<void> {
  const result = await run(base, name)
  flowChecks(result)
  detailChecks(result)
}
