import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import * as Schema from 'effect/Schema'
import { Overlay, SpikeError } from './overlay.ts'

const Saved = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    base: Schema.String,
    changes: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    check: Schema.optional(
      Schema.Struct({
        revision: Schema.String,
        passed: Schema.Boolean,
        diagnostics: Schema.Array(Schema.Unknown),
        elapsedMs: Schema.Number,
        backend: Schema.optional(Schema.Literals(['native', 'docker', 'cloudflare'])),
        imageDigest: Schema.optional(Schema.String),
      }),
    ),
    publication: Schema.optional(
      Schema.Struct({ title: Schema.String, body: Schema.String, commit: Schema.optional(Schema.String) }),
    ),
    published: Schema.optional(Schema.Struct({ url: Schema.String, number: Schema.Number, commit: Schema.String })),
  }),
)

/** Private recovery checkpoints retain overlays and publication intent, never credentials. */
export class State {
  constructor(readonly file: string) {}
  load(base: string, files: ReadonlyMap<string, string>): Overlay[] {
    if (!existsSync(this.file)) return []
    const saved = Schema.decodeUnknownSync(Saved)(JSON.parse(readFileSync(this.file, 'utf8')))
    return saved.map((item) => {
      if (item.base !== base) throw new SpikeError('state_base_mismatch')
      const overlay = new Overlay(base, files, item.id)
      for (const [file, content] of item.changes) overlay.edit(file, content, overlay.revision)
      overlay.check = item.check
      overlay.publication = item.publication
      overlay.published = item.published
      return overlay
    })
  }
  save(overlays: Iterable<Overlay>): void {
    const values = [...overlays].map((overlay) => ({
      id: overlay.id,
      base: overlay.base,
      changes: [...overlay.changes],
      check: overlay.check,
      publication: overlay.publication,
      published: overlay.published,
    }))
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
