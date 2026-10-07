/** Inspect actual provider attributes without repairing infrastructure or printing configuration values. */
import * as Alchemist from 'alchemy/Alchemist'
import { Config, Effect, FileSystem, Schema } from 'effect'
import { resolve } from 'node:path'
import { canonical, observed } from './drift-attributes.ts'

const RecordValue = Schema.Record(Schema.String, Schema.Unknown)
const record = Schema.decodeUnknownSync(RecordValue)
const state = Schema.decodeUnknownSync(Schema.Struct({ attr: RecordValue }))

const program = Effect.gen(function* () {
  const stage = yield* Config.String('GOBLIN_STAGE')
  const root = yield* Config.String('GOBLIN_RELEASE_ROOT').pipe(Config.withDefault('/var/lib/goblin-release'))
  const fs = yield* FileSystem.FileSystem
  const snapshot = yield* Alchemist.Drift.inspect({
    entrypoint: resolve(import.meta.dirname, '../apps/web/alchemy.run.ts'),
    stage,
  })
  const mismatches: string[] = []
  for (const resource of snapshot.resources) {
    const persisted = state(
      JSON.parse(yield* fs.readFileString(`${root}/alchemy/state/goblin/${stage}/${resource.fqn}.json`)),
    )
    if (
      resource.status === 'missing' ||
      canonical(observed(resource.fqn, persisted.attr)) !== canonical(observed(resource.fqn, record(resource.actual)))
    )
      mismatches.push(resource.fqn)
  }
  if (mismatches.length > 0) return yield* Effect.die(new Error(`cloud_drift: ${mismatches.join(',')}`))
  return {
    stage,
    drift: 'verified',
    resources: snapshot.resources.map(({ fqn }) => fqn),
    providerNormalizations: [
      'Web.domain.zone is deployment bookkeeping',
      'goblinAuth.readReplication defaults to disabled',
    ],
  }
})

console.info(JSON.stringify(await Effect.runPromise(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped))))
