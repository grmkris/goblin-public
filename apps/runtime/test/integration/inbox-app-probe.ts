import { createRegistry } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { agentApps } from '../../src/agent-apps/engine.ts'
import { AppRegistry } from '../../src/apps/registry.ts'
import { HomeService } from '../../src/home/service.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { memorySchedules } from './apps-jobs-probe.ts'
import { InboxMcpFixture } from './inbox-mcp.ts'
import { INBOX_APP, INBOX_VIEW } from './inbox-source.ts'

/** Real Dynamic Worker, SQLite and schedule callback with a clock advanced to each 15-minute slot. */
export async function inboxAppProbe(storage: DurableObjectStorage, env: RuntimeEnv, owner: string, harness: PiHarness) {
  const fixture = new InboxMcpFixture()
  const client = new Client({ name: 'inbox-probe', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://inbox-fixture.test/mcp'), { fetch: fixture.fetch }),
  )
  let now = Date.now()
  const apps = agentApps(storage, env, () => owner, { schedules: memorySchedules(), now: () => now })
  apps.attach(createRegistry())
  apps.restore()
  apps.connect({
    tool: async (serverId, name, args) => {
      if (serverId !== 'myinbox') throw new Error('unexpected inbox server')
      return client.callTool({ name, arguments: args })
    },
    complete: async () => '',
    notify: async () => undefined,
    blocked: async () => undefined,
  })
  const registry = new AppRegistry(drizzle(storage), harness, {
    info: (name) => apps.info(name),
    launch: (name) => apps.launch(name),
    rehome: () => undefined,
  })
  apps.onChange((name) => registry.agentChanged(name, 1))
  const built = await apps.build(
    { name: 'inbox-glance', files: { 'app.ts': INBOX_APP, 'view.tsx': INBOX_VIEW } },
    { session: '1', callId: 'inbox-build' },
  )
  if (built.status !== 'active') {
    await client.close()
    return { built }
  }
  apps.answer('inbox-glance', { kind: 'tool', target: 'myinbox/message_list' }, true)
  const fire = async () => {
    const at = apps.jobs.list('inbox-glance')[0]?.nextAt ?? 0
    now = at + 1
    await apps.jobs.fire({ app: 'inbox-glance', action: 'refresh', at })
  }
  await fire()
  const first = apps.snapshot('inbox-glance')
  await fire()
  const refreshed = apps.snapshot('inbox-glance')
  fixture.failed = true
  await fire()
  const lastGood = apps.snapshot('inbox-glance')
  const id = registry.agentId('inbox-glance') ?? ''
  const home = new HomeService(drizzle(storage), registry, apps)
  const placed = home.edit(
    {
      operationId: 'inbox-home',
      expectedRevision: 0,
      ops: [{ kind: 'add', tile: { id: 'inbox', kind: 'app', appId: id, size: 'medium' } }],
    },
    'agent',
  )
  const launch = await registry.launch(id)
  await client.close()
  return {
    built: 'active',
    calls: fixture.calls,
    first,
    refreshed,
    lastGood,
    job: apps.jobs.list('inbox-glance')[0],
    placed,
    app: registry.list()[0],
    launch,
  }
}
