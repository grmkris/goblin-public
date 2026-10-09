import { Container, getContainer } from '@cloudflare/containers'
import { timingSafeEqual } from 'node:crypto'
import { boundedJson, decodeRunnerInput } from '../../coding/scripts/wire.ts'

export interface Env {
  readonly VERIFIER: DurableObjectNamespace<VerifierContainer>
  readonly RUNNER_TOKEN: string
  readonly SPIKE_NAME: string
}

export class VerifierContainer extends Container {
  defaultPort = 8787
  sleepAfter = '10m'
  enableInternet = false
  entrypoint = ['bun', '/spikes/coding-cf/runner/server.ts']
}

const unauthorized = () => new Response('unauthorized', { status: 401 })

const jobId = (request: Request): string | undefined => {
  const value = new URL(request.url).searchParams.get('job')
  return value !== null && /^[a-f0-9]{64}$/u.test(value) ? value : undefined
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const encoder = new TextEncoder()
    const received = await crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('authorization') ?? ''))
    const expected = await crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.RUNNER_TOKEN}`))
    if (!timingSafeEqual(new Uint8Array(received), new Uint8Array(expected))) return unauthorized()
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health')
      return Response.json({
        service: 'goblin-coding-cf-spike',
        sandbox: env.SPIKE_NAME,
        backend: 'cloudflare',
        capacity: { maxInstances: 4, availability: 'provider-managed' },
      })
    if (request.method !== 'POST' || !['/verify', '/execute', '/close'].includes(url.pathname))
      return new Response('not_found', { status: 404 })
    const id = jobId(request)
    if (id === undefined) return new Response('invalid_job', { status: 400 })
    const container = getContainer(env.VERIFIER, url.pathname === '/execute' ? `execute-${id}` : id)
    if (url.pathname === '/close') {
      await container.destroy()
      await getContainer(env.VERIFIER, `execute-${id}`).destroy()
      return Response.json({ closed: true, job: id })
    }
    let input
    try {
      input = decodeRunnerInput(await boundedJson(request))
    } catch {
      return new Response('invalid_input', { status: 400 })
    }
    if (input.session !== id) return new Response('session_mismatch', { status: 400 })
    const forwarded = new Request(`http://container${url.pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (url.pathname !== '/execute') return container.fetch(forwarded)
    try {
      const response = await container.fetch(forwarded)
      const body = await boundedJson(response, 30_000)
      return Response.json(body, { status: response.status })
    } finally {
      await container.destroy()
    }
  },
}
