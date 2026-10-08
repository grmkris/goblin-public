import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Effect, Config, Schema } from 'effect'
import { expect, test } from 'vitest'
import { localTestStack } from '../scripts/local.ts'
import { serveLocal } from '../scripts/http-server.ts'
import { fixtureCorpus, corpusHash } from './transcript-fixture.ts'
import { queryMetrics } from '../src/retrieval-metrics.ts'

const actor = createHash('sha256').update(`retrieval-${Date.now()}`).digest('hex')

test('native workerd FTS5 transcript index: probes, ranks, triggers, and scratch drizzle migration', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* Effect.promise(() => serveLocal(0, async () => new Response(null, { status: 503 })))
        yield* Effect.addFinalizer(() => Effect.promise(() => relay.stop()))
        const { url } = yield* localTestStack(`${relay.url}/v1`)
        const call = (path: string, body?: unknown) =>
          Effect.promise(async () => {
            const response = await fetch(
              `${url}${path}?actor=${actor}`,
              body === undefined
                ? undefined
                : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
            )
            if (!response.ok) throw new Error(`native retrieval ${response.status}: ${await response.text()}`)
            return response.json()
          })
        const { messages, labels } = fixtureCorpus()
        const probe = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            fts5: Schema.Boolean,
            trigram: Schema.Boolean,
            shadowTables: Schema.Array(Schema.Struct({ name: Schema.String })),
          }),
        )(yield* call('/transcript/probe'))
        expect(probe.fts5).toBe(true)
        expect(probe.trigram).toBe(true)
        expect(probe.shadowTables.map((row) => row.name)).toEqual([
          'app_transcript_fts_config',
          'app_transcript_fts_data',
          'app_transcript_fts_docsize',
          'app_transcript_fts_idx',
        ])
        const indexed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            rowsWritten: Schema.Number,
            shadowRows: Schema.Record(Schema.String, Schema.Number),
            afterBytes: Schema.Number,
            beforeBytes: Schema.Number,
            perMessage: Schema.Array(Schema.Number),
            checkpointRowsWritten: Schema.Number,
          }),
        )(yield* call('/transcript/index', messages))
        expect(indexed.rowsWritten).toBeGreaterThan(messages.length)
        expect(indexed.shadowRows.docsize).toBe(messages.length)
        const runs: {
          id: string
          query: string
          rows: readonly { entryId: number; score: number }[]
          ms: number
          metrics: ReturnType<typeof queryMetrics>
        }[] = []
        for (const label of labels) {
          const result = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              rows: Schema.Array(Schema.Struct({ entryId: Schema.Int, score: Schema.Number })),
              ms: Schema.Number,
            }),
          )(yield* call('/transcript/query', label.query))
          runs.push({
            id: label.id,
            query: label.query,
            rows: result.rows,
            ms: result.ms,
            metrics: queryMetrics(label, result.rows),
          })
        }
        yield* call('/transcript/mutate', {
          entryId: messages[3]!.entryId,
          text: 'canaryxyzmutation',
        })
        const updated = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ rows: Schema.Array(Schema.Struct({ entryId: Schema.Int })) }),
        )(yield* call('/transcript/query', 'canaryxyzmutation'))
        expect(updated.rows[0]?.entryId).toBe(messages[3]!.entryId)
        yield* call('/transcript/mutate', { entryId: messages[3]!.entryId, text: null })
        const deleted = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ rows: Schema.Array(Schema.Struct({ entryId: Schema.Int })) }),
        )(yield* call('/transcript/query', 'canaryxyzmutation'))
        expect(deleted.rows).toHaveLength(0)
        const migration = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ appliedTwice: Schema.Boolean, fts5: Schema.Boolean }),
        )(yield* call('/transcript/migrate'))
        expect(migration).toMatchObject({ appliedTwice: true, fts5: true })
        if (yield* Config.Boolean('GOBLIN_RETRIEVAL_RECORD').pipe(Config.withDefault(false)))
          yield* Effect.promise(() =>
            writeFile(
              '../.local/bench/retrieval/native-results.json',
              JSON.stringify(
                {
                  corpusHash: corpusHash(messages, labels),
                  messageCount: messages.length,
                  labelCount: labels.length,
                  indexed,
                  runs,
                  migration,
                  probe,
                },
                null,
                2,
              ),
              { mode: 0o600 },
            ),
          )
      }),
    ),
  )
}, 240_000)
