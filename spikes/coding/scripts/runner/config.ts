import * as Schema from 'effect/Schema'
import { readFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { compilers } from '../binaries.ts'
import {
  RunnerError,
  type CodingRunnerFactory,
  type CodingRunnerLease,
  type RunnerSessionSpec,
  type VerifyRequest,
} from './contract.ts'
import { DockerRunner } from './docker.ts'
import { HttpRunner, httpsTransport } from './http.ts'
import { NativeRunner } from './native.ts'

export const RunnerConfig = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('native') }),
  Schema.Struct({ kind: Schema.Literal('docker'), image: Schema.String, cpu: Schema.Number, memoryMb: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal('cloudflare'),
    endpoint: Schema.String,
    credentialRef: Schema.String,
    imageDigest: Schema.optional(Schema.String),
  }),
])
export type RunnerConfig = typeof RunnerConfig.Type
export async function configured(
  config: RunnerConfig,
  options: { state: string; files: ReadonlyMap<string, string>; live: ReadonlySet<string> },
): Promise<CodingRunnerFactory> {
  switch (config.kind) {
    case 'native':
      return new NativeRunner(options.files, compilers(options.state))
    case 'docker': {
      const runner = new DockerRunner({
        image: config.image,
        cpu: config.cpu,
        memoryMb: config.memoryMb,
        state: path.join(options.state, 'docker'),
      })
      await runner.reconcile(options.live)
      return runner
    }
    case 'cloudflare': {
      const file = path.resolve(config.credentialRef)
      const privateRoot = path.resolve(import.meta.dirname, '../../../../.local')
      if (!file.startsWith(`${privateRoot}/`) || (await lstat(file)).mode & 0o077)
        throw new RunnerError('rejected-input')
      if (!(await lstat(file)).isFile() || (await lstat(file)).size > 4096) throw new RunnerError('rejected-input')
      const image: { imageDigest: string } = config.imageDigest
        ? { imageDigest: config.imageDigest }
        : await Bun.file(path.join(privateRoot, 'coding-cf-spike/image-receipt.json')).json()
      const token = (await readFile(file, 'utf8')).match(/^GOBLIN_CODING_RUNNER_TOKEN=([A-Za-z0-9_-]+)$/mu)?.[1]
      if (!token || !/^sha256:[a-f0-9]{64}$/u.test(image.imageDigest)) throw new RunnerError('rejected-input')
      return new HttpRunner(httpsTransport(config.endpoint, token), 'cloudflare', image.imageDigest)
    }
  }
}

/** Only one explicitly configured alternate is tried, and only after provider failure. */
export class FallbackRunner implements CodingRunnerFactory {
  constructor(
    readonly primary: CodingRunnerFactory,
    readonly alternate: CodingRunnerFactory,
  ) {}
  async create(spec: RunnerSessionSpec): Promise<CodingRunnerLease> {
    let lease: CodingRunnerLease
    let switched = false
    const switchBackend = async (error: unknown) => {
      if (switched || !(error instanceof RunnerError) || error.reason !== 'provider-unavailable') throw error
      switched = true
      lease = await this.alternate.create(spec)
    }
    try {
      lease = await this.primary.create(spec)
    } catch (error) {
      // expected: switchBackend rethrows anything but an unavailable provider, which the alternate replaces
      await switchBackend(error)
    }
    return {
      verify: async (request: VerifyRequest) => {
        try {
          return await lease.verify(request)
        } catch (error) {
          if (switched || !(error instanceof RunnerError) || error.reason !== 'provider-unavailable') throw error
          // expected: closing the lease that failed is best effort before switching backends
          await lease.close().catch(() => undefined)
          await switchBackend(error)
          return lease.verify(request)
        }
      },
      execute: (request) => lease.execute(request),
      close: () => lease.close(),
    }
  }
}
