import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { digest, Overlay, SpikeError, type Check } from './overlay.ts'
import type { GitHub } from './github.ts'
import { Verifier } from './verifier.ts'
import { State } from './state.ts'

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const standard = (schema: Schema.Top & Schema.ConstraintDecoder<unknown>): StandardSchemaWithJSON =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Session = Schema.Struct({ session: Bounded(64) })
const Revision = Schema.Struct({ session: Bounded(64), revision: Bounded(64) })

export interface CodingVerifier {
  ready(): Promise<Check>
  close(): Promise<void>
}

export class Coding {
  readonly sessions = new Map<string, { overlay: Overlay; verifier: CodingVerifier }>()
  checking = false
  readonly state: State
  constructor(
    readonly options: {
      root: string
      base: string
      files: ReadonlyMap<string, string>
      compilers: { type: string; effect: string }
      github: GitHub
      state: string
      verifier?: (overlay: Overlay) => CodingVerifier
    },
  ) {
    this.state = new State(options.state)
    for (const overlay of this.state.load(options.base, options.files)) this.add(overlay)
  }

  private add(overlay: Overlay): void {
    const { root, compilers } = this.options
    this.sessions.set(overlay.id, {
      overlay,
      verifier: this.options.verifier?.(overlay) ?? new Verifier(root, overlay, compilers.effect, compilers.type),
    })
  }

  private save(): void {
    this.state.save([...this.sessions.values()].map((session) => session.overlay))
  }

  private session(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new SpikeError('session_not_found')
    return session
  }

  // oxlint-disable-next-line max-lines-per-function -- Keeping the seven tool contracts together makes the exposed capability boundary auditable.
  server(): McpServer {
    const server = new McpServer({ name: 'goblin-coding-spike', version: '0.1.0' })
    const register = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
      name: string,
      description: string,
      input: S,
      work: (args: S['Type']) => Promise<unknown>,
      readOnly = false,
    ) => {
      server.registerTool(
        name,
        {
          description,
          inputSchema: standard(input),
          annotations: { readOnlyHint: readOnly, openWorldHint: name === 'coding_submit' },
        },
        async (args) => {
          try {
            return text(await work(Schema.decodeUnknownSync(input)(args)))
          } catch (error) {
            return {
              ...text({ error: error instanceof SpikeError ? error.message : 'coding_operation_failed' }),
              isError: true,
            }
          }
        },
      )
    }
    register(
      'coding_open',
      'Open an in-memory coding session on grmkris/goblin. This spike edits only apps/cli/src and apps/cli/test TypeScript. Returns the frozen base and revision.',
      Schema.Struct({ operationId: Bounded(100) }),
      async (args) => {
        const { base, files } = this.options
        const id = digest(args.operationId)
        const existing = this.sessions.get(id)
        if (existing)
          return {
            session: id,
            revision: existing.overlay.revision,
            base,
            files: [...files.keys()].filter((file) => file.startsWith('apps/cli/')),
          }
        if (this.sessions.size >= 4) throw new SpikeError('session_capacity')
        const overlay = new Overlay(base, files, id)
        this.add(overlay)
        this.save()
        return {
          session: overlay.id,
          revision: overlay.revision,
          repo: 'grmkris/goblin',
          base,
          editable: ['apps/cli/src/**/*.ts', 'apps/cli/test/**/*.ts'],
          files: [...files.keys()].filter((file) => file.startsWith('apps/cli/')),
        }
      },
    )
    register(
      'coding_read',
      'Read a tracked text file from the frozen repo or this session overlay. No host files or secrets.',
      Schema.Struct({ ...Session.fields, path: Bounded(300) }),
      async (args) => {
        const { overlay } = this.session(args.session)
        return { revision: overlay.revision, path: args.path, content: overlay.read(args.path) }
      },
      true,
    )
    register(
      'coding_search',
      'Search CLI source and test text by literal substring. Results are bounded.',
      Schema.Struct({ ...Session.fields, query: Bounded(200) }),
      async (args) => {
        const { overlay } = this.session(args.session)
        const matches = []
        for (const file of new Set([...this.options.files.keys(), ...overlay.changes.keys()])) {
          if (!file.startsWith('apps/cli/') || !file.endsWith('.ts')) continue
          const lines = overlay.read(file).split('\n')
          for (let i = 0; i < lines.length && matches.length < 30; i++) {
            const line = lines[i] ?? ''
            if (line.includes(args.query)) matches.push({ path: file, line: i + 1, text: line.slice(0, 500) })
          }
        }
        return { revision: overlay.revision, matches }
      },
      true,
    )
    register(
      'coding_edit',
      'Replace a CLI TypeScript file in memory. Supply the current revision; no shell, config, dependencies, deletion or Git access.',
      Schema.Struct({
        ...Revision.fields,
        path: Bounded(300),
        content: Schema.String.check(Schema.isMaxLength(60_000)),
      }),
      async (args) => {
        const { overlay } = this.session(args.session)
        const revision = overlay.edit(args.path, args.content, args.revision)
        this.save()
        return { revision, changedFiles: [...overlay.changes.keys()] }
      },
    )
    register(
      'coding_ready',
      'Check this exact revision with the real repo TypeScript, Effect, type-aware Oxlint and Oxfmt. Fix all diagnostics, including formattedContent, and call ready again before submit.',
      Revision,
      async (args) => {
        if (this.checking) throw new SpikeError('verifier_busy_retry_later')
        const { overlay, verifier } = this.session(args.session)
        if (overlay.revision !== args.revision) throw new SpikeError('stale_revision')
        this.checking = true
        try {
          return await overlay.exclusive(async () => {
            overlay.check = undefined
            this.save()
            try {
              overlay.check = await verifier.ready()
              this.save()
              return overlay.check
            } catch (error) {
              await verifier.close()
              this.add(overlay)
              throw error
            }
          })
        } finally {
          this.checking = false
        }
      },
    )
    register(
      'coding_submit',
      'Create a draft GitHub PR for this exact green revision. No merge or deploy. Repeated calls return the same PR. The runner adds an honest validation receipt to the body.',
      Schema.Struct({ ...Revision.fields, title: Bounded(150), body: Bounded(5000) }),
      async (args) => {
        const { overlay } = this.session(args.session)
        overlay.assertReady(args.revision)
        if (overlay.published) return overlay.published
        return overlay.exclusive(async () => {
          if (
            overlay.publication &&
            (overlay.publication.title !== args.title || overlay.publication.body !== args.body)
          )
            throw new SpikeError('publication_metadata_frozen')
          overlay.publication ??= { title: args.title, body: args.body }
          this.save()
          overlay.published = await this.options.github.publish(overlay, args.title, args.body, () => this.save())
          this.save()
          return overlay.published
        })
      },
    )
    register(
      'coding_close',
      'Release the session compiler/linter processes. An existing draft PR remains on GitHub.',
      Session,
      async (args) => {
        const { overlay, verifier } = this.session(args.session)
        if (overlay.busy) throw new SpikeError('session_busy')
        await verifier.close()
        this.sessions.delete(args.session)
        this.save()
        return { closed: true }
      },
    )
    return server
  }
}
