import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { unwrap } from '../../src/http/rpc.ts'
import { askResult, recentResult } from '../internal-client.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'
import { ownerSend } from './probe-reads.ts'

/** The owner's send, an inbound client's ask and a recent-messages read on main, with where each landed in Pi. */
async function primaryProfileProbe({ agent, api, storage, harness }: Inside) {
  const operationId = 'permuted-primary-proof'
  await ownerSend(api, PRIMARY_CHAT, 'prove the primary binding', operationId)
  const settled = await agent.settle(PRIMARY_CHAT, operationId)
  const directory = new ChatDirectory(drizzle(storage))
  const session = directory.session(PRIMARY_CHAT)
  const inbound = unwrap(await askResult(api, 'fixture-client', 'inbound binding proof', 'primary-inbound', 5000))
  const recent = unwrap(await recentResult(api, 20))
  return {
    session,
    inboundStatus: inbound.status,
    inboundSession: directory.operation(PRIMARY_CHAT, 'primary-inbound'),
    recentInbound: recent.some(
      (message) => message.author === 'fixture-client' && message.text === 'inbound binding proof',
    ),
    settledSession: settled.session,
    rootMessages: (await harness.messages({ session: '1' })).length,
    primaryMessages: (await harness.messages({ session })).length,
  }
}

export const probes: Probes = { 'primary-profile': inAgent(primaryProfileProbe) }

const Proof = Schema.Struct({
  session: Schema.String,
  settledSession: Schema.String,
  rootMessages: Schema.Number,
  primaryMessages: Schema.Number,
  inboundStatus: Schema.String,
  inboundSession: Schema.String,
  recentInbound: Schema.Boolean,
})

/** Owner admission, inbound wait and recent-message reads all follow chat 1's non-root Pi binding. */
async function primaryBindingChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'primary-profile', Proof, 'primary-proof')
  expect(result.session).not.toBe('1')
  expect(result.settledSession).toBe(result.session)
  expect(result.inboundStatus).toBe('done')
  expect(result.inboundSession).toBe(result.session)
  expect(result.recentInbound).toBe(true)
  expect(result.rootMessages).toBe(0)
  expect(result.primaryMessages).toBeGreaterThan(0)
}

/** The permuted profile's own case: it runs only when main is bound to a non-root Pi session. */
export const permutedCases: readonly NativeCase[] = [
  { title: 'the stable primary chat writes only to its non-root Pi session', run: primaryBindingChecks },
]
