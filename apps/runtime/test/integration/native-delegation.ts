import { PRIMARY_CHAT } from '@goblin/contracts'
import { FlowRecord, InspectDetails } from '@goblin/contracts/inspect'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { inspectResult } from '../internal-client.ts'
import { callOwner } from '../owner-client.ts'
import { Ok } from './conversation-checks.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Probes, type ProbeStub, inWorker } from './probe.ts'
import { exchange, ownerSend, snapshotOf, transcript } from './probe-reads.ts'
import { until } from './until.ts'

const ASK = 'flows-ask'
const SPAWN = 'flows-spawn'

/**
 * The flows a Persona and a Delegate leave: the owner tags a Persona in main and it answers; main spawns a
 * subagent, which reports. Then the run ledger's flow rows, and the details of the ask and of the spawn's turn.
 */
async function delegationFlowsSequence(agent: ProbeStub) {
  const scout = await callOwner(agent, (api) =>
    api.personas.create({
      payload: {
        name: 'Scout',
        avatar: { glyph: 'S', hue: 120 },
        role: 'Finds things out',
        instructions: 'Be brief.',
        setup: { mcpServers: [], skills: [], apps: [] },
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
    () => inspectResult(agent, { kind: 'flows', chat: PRIMARY_CHAT }),
    (result) => JSON.stringify(result).includes('subagent_report'),
  )
  return {
    flows,
    askDetails: await inspectResult(agent, { kind: 'details', operation: ASK }),
    spawnDetails: await inspectResult(agent, { kind: 'details', operation: SPAWN }),
  }
}

export const probes: Probes = { 'delegation-flows': inWorker(({ agent }) => delegationFlowsSequence(agent)) }
const DelegationFlowsRun = Schema.Struct({
  flows: Ok(Schema.Struct({ flows: Schema.Array(FlowRecord) })),
  askDetails: Schema.Unknown,
  spawnDetails: Schema.Unknown,
})
const decodeDetails = Schema.decodeUnknownSync(Ok(InspectDetails))

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
 * spawned the subagent name the subagent's report.
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

export const cases: readonly NativeCase[] = [
  {
    title: 'a Persona answer, a spawn and a report are one flow row each, and details relate them',
    run: async (base) => {
      const result = await probeOf(base, 'delegation-flows', DelegationFlowsRun)
      flowChecks(result)
      detailChecks(result)
    },
  },
]
