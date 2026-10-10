import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import { nextInt } from 'effect/Random'
import { FIXTURE_INPUT, fixtureModels, model } from './model.ts'
import { type Probe, type Probes, inWorker } from './probe.ts'
import { skillsCacheProbe, skillsLearnerRejectionProbe, skillsPersistedRead } from './skills-probe.ts'

/** Same public factory/lifecycle seam as PersonalAgent, with a keyless deterministic model. */
export class NativeLifecycleProbe extends Agent {
  readonly instance = String(Effect.runSync(nextInt))
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(storage, { models: fixtureModels(), registry: createRegistry() }, context),
    defaults: { model, thinkingLevel: 'low' },
  })

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.lifecycle.use(this.harness)
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const operationId = url.searchParams.get('operationId') ?? 'missing-fixture-operation'
    if (url.pathname === '/skills-rejection')
      return Response.json(await skillsLearnerRejectionProbe(this.ctx.storage, this.harness))
    if (url.pathname === '/skills-write') {
      await skillsCacheProbe(this.ctx.storage)
      return Response.json({ instance: this.instance, retained: await skillsPersistedRead(this.ctx.storage) })
    }
    if (url.pathname === '/skills-read')
      return Response.json({ instance: this.instance, retained: await skillsPersistedRead(this.ctx.storage) })
    if (url.pathname === '/skills-evict') this.ctx.abort('skills acceptance restart')
    if (url.pathname === '/submit') return Response.json(await this.harness.submit(FIXTURE_INPUT, { operationId }))
    if (url.pathname === '/wait') return Response.json(await this.harness.wait(operationId))
    if (url.pathname === '/read')
      return Response.json({ instance: this.instance, messages: await this.harness.messages() })
    if (url.pathname === '/reopen') {
      const before = await this.harness.pi()
      await this.harness.dispose()
      const after = await this.harness.pi()
      return Response.json({ replacedPiInstance: before !== after, messages: await this.harness.messages() })
    }
    return Response.json({ sessions: await this.harness.sessions.list() })
  }
}

/** A step of the lifecycle object named `name`, through its own `fetch` as a Worker request reaches it. */
const step = (path: string): Probe =>
  inWorker(async ({ env, name, url }) => {
    const operationId = url.searchParams.get('operationId') ?? 'missing-fixture-operation'
    const response = await env.LIFECYCLE.getByName(name).fetch(`https://lifecycle${path}?operationId=${operationId}`)
    return response.json()
  })

export const probes: Probes = {
  'lifecycle-sessions': step('/sessions'),
  'lifecycle-submit': step('/submit'),
  'lifecycle-wait': step('/wait'),
  'lifecycle-read': step('/read'),
  'lifecycle-reopen': step('/reopen'),
  'skills-rejection': step('/skills-rejection'),
  'skills-write': step('/skills-write'),
  'skills-read': step('/skills-read'),
  'skills-evict': step('/skills-evict'),
}
