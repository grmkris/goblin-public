import * as Schema from 'effect/Schema'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { bounded } from '../lsp.ts'
import { digest } from '../overlay.ts'
import {
  ExecutionReceipt,
  validateRequest,
  limits,
  RunnerError,
  type CodingRunnerFactory,
  RunnerSessionSpec,
  type VerifyRequest,
} from './contract.ts'
import { HttpLease, type Transport } from './http.ts'
import { boundedJson } from '../wire.ts'

export type DockerOptions = { image: string; state: string; cpu?: number; memoryMb?: number }

/** Docker client output never includes container environments or provider credentials. */
export async function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  const child = Bun.spawn(['/usr/bin/docker', ...args], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'ignore',
  })
  try {
    const [output, exit] = await bounded(Promise.all([new Response(child.stdout).text(), child.exited]), timeoutMs)
    if (exit !== 0 || output.length > 100_000) throw new RunnerError('provider-unavailable')
    return output.trim()
  } catch {
    child.kill()
    throw new RunnerError('provider-unavailable')
  }
}

export function containerFlags(session: string, owner: string, role: string, cpu = 1, memoryMb = 3072): string[] {
  return [
    '--label',
    'goblin.coding=1',
    '--label',
    `goblin.coding.session=${session}`,
    '--label',
    `goblin.coding.owner=${owner}`,
    '--label',
    `goblin.coding.role=${role}`,
    '--network',
    'none',
    '--cpus',
    String(cpu),
    '--memory',
    `${memoryMb}m`,
    '--pids-limit',
    '256',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--user',
    '1000:1000',
    '--tmpfs',
    '/state:rw,exec,nosuid,size=64m,uid=1000,gid=1000,mode=700',
    '--tmpfs',
    '/execution:rw,exec,nosuid,size=512m,uid=1000,gid=1000,mode=700',
  ]
}

type Resource = { name: string; directory: string; socket: string; id?: string }
export class DockerRunner implements CodingRunnerFactory {
  readonly owner: string
  imageDigest: string | undefined
  private readonly active = new Set<string>()
  constructor(readonly options: DockerOptions) {
    this.owner = digest(path.resolve(options.state))
    if (
      !/^[\w./:@-]+$/u.test(options.image) ||
      options.image.startsWith('-') ||
      (options.cpu ?? 1) <= 0 ||
      (options.cpu ?? 1) > 1 ||
      (options.memoryMb ?? 3072) < 512 ||
      (options.memoryMb ?? 3072) > 3072
    )
      throw new RunnerError('rejected-input')
  }

  async reconcile(liveSessions: ReadonlySet<string> = new Set()): Promise<void> {
    const rows = await docker([
      'ps',
      '-a',
      '--filter',
      'label=goblin.coding=1',
      '--filter',
      `label=goblin.coding.owner=${this.owner}`,
      '--format',
      '{{.ID}} {{.Label "goblin.coding.session"}} {{.Label "goblin.coding.role"}} {{.Label "goblin.coding.transport"}}',
    ])
    for (const row of rows.split('\n').filter(Boolean)) {
      const [id, session, role, directory] = row.split(' ')
      if (id && (role === 'execute' || !session || !liveSessions.has(session))) {
        await docker(['rm', '-f', id])
        if (
          directory &&
          path.dirname(directory) === path.resolve(this.options.state) &&
          /^socket-[\w-]+$/u.test(path.basename(directory))
        )
          await rm(directory, { recursive: true, force: true })
      }
    }
  }

  private async remove(resource: Resource): Promise<void> {
    const filter = resource.id ? `id=${resource.id}` : `name=^/${resource.name}$`
    const ids = await docker(['ps', '-aq', '--filter', filter])
    if (ids) await docker(['rm', '-f', ...ids.split('\n')])
    await rm(resource.directory, { recursive: true, force: true })
  }

  private async start(spec: RunnerSessionSpec, role: 'verify' | 'execute'): Promise<Resource> {
    await mkdir(this.options.state, { recursive: true, mode: 0o700 })
    await chmod(this.options.state, 0o700)
    const directory = await mkdtemp(path.join(this.options.state, 'socket-'))
    const resource: Resource = {
      name: `goblin-coding-${this.owner.slice(0, 8)}-${spec.taskId}-${role}`,
      directory,
      socket: path.join(directory, 'runner.sock'),
    }
    try {
      const old = await docker(['ps', '-aq', '--filter', `name=^/${resource.name}$`])
      if (old) {
        const previous = await docker([
          'inspect',
          resource.name,
          '--format',
          '{{index .Config.Labels "goblin.coding.transport"}}',
        ])
        await docker(['rm', '-f', resource.name])
        if (
          path.dirname(previous) === path.resolve(this.options.state) &&
          /^socket-[\w-]+$/u.test(path.basename(previous))
        )
          await rm(previous, { recursive: true, force: true })
      }
      this.imageDigest ??=
        this.options.image.split('@')[1] ??
        (await docker(['image', 'inspect', this.options.image, '--format', '{{.Id}}']))
      if (!/^sha256:[a-f0-9]{64}$/u.test(this.imageDigest)) throw new RunnerError('provider-unavailable')
      resource.id = await docker(
        [
          'run',
          '-d',
          ...(role === 'execute' ? ['--rm'] : []),
          '--name',
          resource.name,
          ...containerFlags(spec.taskId, this.owner, role, this.options.cpu, this.options.memoryMb),
          '--label',
          `goblin.coding.transport=${directory}`,
          '--mount',
          `type=bind,source=${directory},target=/transport`,
          '--env',
          'RUNNER_SOCKET=/transport/runner.sock',
          this.options.image,
        ],
        spec.limits.verifyTimeoutMs,
      )
      const deadline = performance.now() + spec.limits.verifyTimeoutMs
      while (performance.now() < deadline) {
        try {
          const response = await fetch('http://runner/health', {
            unix: resource.socket,
            signal: AbortSignal.timeout(1000),
          })
          if (response.ok) {
            await response.body?.cancel()
            return resource
          }
          await response.body?.cancel()
        } catch {
          /* The container has not opened its socket yet. */
        }
        await Bun.sleep(100)
      }
      throw new RunnerError('provider-unavailable')
    } catch (error) {
      await this.remove(resource)
      throw error
    }
  }

  private request(resource: Resource, operation: string, input: VerifyRequest, timeoutMs: number): Promise<Response> {
    return fetch(`http://runner/${operation}`, {
      unix: resource.socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /** Operator-only disposable execution; the calling lease has already required a green revision. */
  async executeChecked(spec: RunnerSessionSpec, input: VerifyRequest): Promise<typeof ExecutionReceipt.Type> {
    validateRequest(spec, input)
    const started = performance.now()
    const execution = await this.start(
      { ...spec, limits: { ...limits, ...spec.limits, verifyTimeoutMs: spec.limits.executeTimeoutMs } },
      'execute',
    )
    try {
      const response = await this.request(execution, 'execute', input, spec.limits.executeTimeoutMs)
      if (!response.ok) {
        await response.body?.cancel()
        throw new RunnerError('provider-unavailable')
      }
      const value = await boundedJson(response, spec.limits.maxOutputBytes + 2_000)
      if (typeof value !== 'object' || value === null) throw new RunnerError('provider-unavailable')
      return Schema.decodeUnknownSync(ExecutionReceipt)({
        ...value,
        profile: 'cli-hello',
        elapsedMs: Math.round(performance.now() - started),
        backend: 'docker',
        imageDigest: this.imageDigest,
      })
    } finally {
      await this.remove(execution)
    }
  }

  async create(spec: RunnerSessionSpec): Promise<HttpLease> {
    try {
      Schema.decodeUnknownSync(RunnerSessionSpec)(spec, { onExcessProperty: 'error' })
    } catch {
      throw new RunnerError('rejected-input')
    }
    if (this.active.has(spec.taskId)) throw new RunnerError('busy')
    this.active.add(spec.taskId)
    let resource: Resource
    try {
      resource = await this.start(spec, 'verify')
    } catch (error) {
      this.active.delete(spec.taskId)
      throw error
    }
    const transport: Transport = async (operation, input, timeoutMs) => {
      if (operation === 'close') {
        try {
          await this.remove(resource)
        } finally {
          this.active.delete(spec.taskId)
        }
        return Response.json({ closed: true })
      }
      if (operation === 'verify') return this.request(resource, operation, input, timeoutMs)
      return Response.json(await this.executeChecked(spec, input))
    }
    return new HttpLease(spec, transport, 'docker', this.imageDigest)
  }
}
