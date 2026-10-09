import { drizzle } from 'drizzle-orm/durable-sqlite'
import { McpApprovalStore } from '../../src/mcp/approvals.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { GrantStore } from '../../src/mcp/grants.ts'
import type { ApprovedDispatch } from '../../src/mcp/types.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'

/** Native SQLite recovery and argument/context fencing; no external call is replayed by reconstruction. */
export async function approvalsProbe(storage: DurableObjectStorage, key: string) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const cipher = await CredentialCipher.fromBase64(key)
  const store = new McpApprovalStore(db, cipher)
  const grants = new GrantStore(db)
  const grant = { serverId: 'probe', name: 'write', capability: 'tool' as const }
  grants.set(grant, true, 1)
  grants.setAskFirst(grant, true)
  const version = () => grants.policy(grant)?.version
  const args = { operationKey: 'same-operation', rewardToken: '0x123', accessToken: 'fixture-private' }
  const call: ApprovedDispatch = {
    ...grant,
    endpoint: 'https://probe.test/mcp',
    arguments: args,
    caller: 'model',
    approvalContext: { sessionId: '1', sourceCallId: 'call', taskId: 'task' },
  }
  const held = {
    id: crypto.randomUUID(),
    ...grant,
    ...call.approvalContext,
    endpoint: call.endpoint,
    arguments: args,
    caller: 'model' as const,
    grantVersion: version() ?? '',
  }
  await store.hold(held, 1)
  store.decide(held.id, true, 2)
  const refused: string[] = []
  for (const [label, changed] of [
    ['arguments', { ...call, arguments: { ...args, operationKey: 'changed' } }],
    [
      'session',
      {
        ...call,
        approvalContext: { ...call.approvalContext, sessionId: 'other', sourceCallId: 'call', taskId: 'task' },
      },
    ],
    ['endpoint', { ...call, endpoint: 'https://other.test/mcp' }],
    ['caller', { ...call, caller: 'app' as const }],
  ] as const) {
    try {
      await store.assert({ id: held.id, call: changed, version, now: 3, dispatch: false })
    } catch {
      // expected: a changed call is refused; the probe answers with which ones were
      refused.push(label)
    }
  }
  await store.assert({ id: held.id, call, version, now: 3, dispatch: true })
  const dispatching = store.get(held.id).state
  const reconstructed = new McpApprovalStore(db, cipher)
  reconstructed.recover(4)
  let replayRefused = false
  try {
    await reconstructed.assert({ id: held.id, call, version, now: 5, dispatch: true })
  } catch {
    // expected: a replayed dispatch is refused; the probe answers whether it was
    replayRefused = true
  }
  const exact = await reconstructed.arguments(held.id)
  const view = await reconstructed.view(held.id, 5)
  runApplicationMigrations(storage)
  return { refused, dispatching, state: reconstructed.get(held.id).state, replayRefused, exact, view }
}
