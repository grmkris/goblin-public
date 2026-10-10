import { PRIMARY_CHAT } from '@goblin/contracts'
import { FileStore } from '../../src/files/store.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'
import { ownerSend } from './probe-reads.ts'
import { until } from './until.ts'

const files = ({ storage, env, name }: Inside) => new FileStore(storage.sql, env.FILES, () => name)

/** A real Dynamic Worker writes before eviction interrupts its Pi tool intent. */
async function codeRecoveryWrite(inside: Inside) {
  const store = files(inside)
  await store.write('agent', '/agent/replay.txt', '', 'text/plain', 0)
  const code =
    "await files.write('/agent/replay.txt', (await files.read('/agent/replay.txt')) + 'x'); await new Promise(resolve => setTimeout(resolve, 30000)); return null"
  await ownerSend(inside.api, PRIMARY_CHAT, `call code_run ${JSON.stringify({ code })}`, 'code-recovery')
  const written = await until(
    () => store.text('/agent/replay.txt', 0, 100),
    (file) => file.text === 'x',
  )
  return { instance: inside.agent.instance, text: written.text }
}

/** After the restart: the interrupted run's file holds the one write, and the turn settled as interrupted. */
async function codeRecoveryRead(inside: Inside) {
  const result = await inside.agent.settle(PRIMARY_CHAT, 'code-recovery')
  return {
    instance: inside.agent.instance,
    text: (await files(inside).text('/agent/replay.txt', 0, 100)).text,
    result,
  }
}

export const probes: Probes = {
  'code-recovery-write': inAgent(codeRecoveryWrite),
  'code-recovery-read': inAgent(codeRecoveryRead),
}
