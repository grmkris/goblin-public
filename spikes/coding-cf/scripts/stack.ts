import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect } from 'effect'
import path from 'node:path'
import type { VerifierContainer } from '../src/index.ts'

export default Alchemy.Stack(
  'goblinCodingCfSpike',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    if (stage !== 'dev') return yield* Effect.die(new Error('coding_spike_dev_only'))
    const image = yield* Config.String('GOBLIN_CODING_IMAGE_CONTEXT').pipe(
      Config.withDefault(path.resolve(import.meta.dirname, '../../../.local/coding-cf-spike/image')),
    )
    const worker = yield* Cloudflare.Worker('VerifierWorker', {
      name: `goblin-coding-cf-${stage}`,
      main: path.resolve(import.meta.dirname, '../src/index.ts'),
      compatibility: { date: '2026-10-08', flags: ['nodejs_compat'] },
      observability: { enabled: true, traces: { enabled: true } },
      env: {
        VERIFIER: Cloudflare.Container<VerifierContainer>('VerifierContainer', {
          context: image,
          className: 'VerifierContainer',
          instanceType: 'standard-2',
          maxInstances: 4,
          observability: { logs: { enabled: true } },
        }),
        RUNNER_TOKEN: Config.Redacted('GOBLIN_CODING_RUNNER_TOKEN'),
        SPIKE_NAME: 'cloudflare-container',
      },
    })
    return { url: worker.url }
  }),
)
