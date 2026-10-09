import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import rpc from '../node_modules/typescript/vendor/vscode-jsonrpc/lib/node/main.js'
import * as Schema from 'effect/Schema'
import { SpikeError } from './overlay.ts'

const Position = Schema.Struct({ line: Schema.Number, character: Schema.Number })
const LintResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      severity: Schema.optional(Schema.Number),
      code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      range: Schema.Struct({ start: Position, end: Position }),
    }),
  ),
})
const Edits = Schema.NullOr(
  Schema.Array(
    Schema.Struct({
      range: Schema.Struct({ start: Position, end: Position }),
      newText: Schema.String,
    }),
  ),
)
const WorkspaceConfig = Schema.Struct({ items: Schema.Array(Schema.Unknown) })

/** Pinned trusted LSPs see unsaved documents, never execute the agent's source, and inherit no credentials. */
export class Lsp {
  readonly child: ChildProcessWithoutNullStreams
  readonly connection: rpc.MessageConnection
  readonly versions = new Map<string, number>()
  private constructor(
    readonly root: string,
    readonly kind: 'oxlint' | 'oxfmt',
  ) {
    this.child = spawn(`${root}/node_modules/.bin/${kind}`, ['--lsp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    })
    this.child.stderr.on('data', () => {})
    this.connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.child.stdout),
      new rpc.StreamMessageWriter(this.child.stdin),
    )
    this.connection.onRequest('workspace/configuration', (params: unknown) =>
      Schema.decodeUnknownSync(WorkspaceConfig)(params).items.map(() => ({
        configPath: `${root}/${kind}.config.ts`,
        typeAware: true,
      })),
    )
    this.connection.onRequest('client/registerCapability', () => null)
    for (const name of ['window/logMessage', 'window/showMessage', 'textDocument/publishDiagnostics'])
      this.connection.onNotification(name, () => {})
    this.connection.listen()
  }

  static async open(root: string, kind: 'oxlint' | 'oxfmt'): Promise<Lsp> {
    const lsp = new Lsp(root, kind)
    const uri = pathToFileURL(root).href
    try {
      await bounded(
        lsp.connection.sendRequest('initialize', {
          processId: process.pid,
          rootUri: uri,
          capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } },
          workspaceFolders: [{ uri, name: 'goblin' }],
          initializationOptions: [
            { workspaceUri: uri, options: { configPath: `${root}/${kind}.config.ts`, typeAware: true } },
          ],
        }),
      )
    } catch (error) {
      lsp.dispose()
      throw error
    }
    await lsp.connection.sendNotification('initialized', {})
    return lsp
  }

  async document(file: string, text: string): Promise<string> {
    const uri = pathToFileURL(`${this.root}/${file}`).href
    const old = this.versions.get(uri)
    const version = (old ?? 0) + 1
    if (old === undefined)
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'typescript', version, text },
      })
    else
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
    this.versions.set(uri, version)
    return uri
  }

  async lint(file: string, content: string) {
    const uri = await this.document(file, content)
    const value = Schema.decodeUnknownSync(LintResult)(
      await this.connection.sendRequest('textDocument/diagnostic', { textDocument: { uri } }),
    )
    return value.items
      .filter((item) => item.severity === 1)
      .map((item) => ({
        file,
        source: 'oxlint',
        code: item.code,
        message: item.message,
        line: item.range.start.line + 1,
      }))
  }

  async forget(file: string): Promise<void> {
    const uri = pathToFileURL(`${this.root}/${file}`).href
    if (!this.versions.delete(uri)) return
    await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri } })
  }

  async format(file: string, content: string): Promise<string> {
    const uri = await this.document(file, content)
    const edits =
      Schema.decodeUnknownSync(Edits)(
        await this.connection.sendRequest('textDocument/formatting', {
          textDocument: { uri },
          options: { tabSize: 2, insertSpaces: true },
        }),
      ) ?? []
    const offset = (position: typeof Position.Type): number =>
      content
        .split('\n')
        .slice(0, position.line)
        .reduce((sum, line) => sum + line.length + 1, 0) + position.character
    let formatted = content
    for (const edit of edits.toSorted((a, b) => offset(b.range.start) - offset(a.range.start)))
      formatted = formatted.slice(0, offset(edit.range.start)) + edit.newText + formatted.slice(offset(edit.range.end))
    return formatted
  }

  async close(): Promise<void> {
    try {
      await bounded(this.connection.sendRequest('shutdown', null), 1000)
    } catch {
      // expected: a crashed LSP has nothing to shut down
    }
    this.dispose()
  }

  private dispose(): void {
    this.connection.dispose()
    this.child.kill()
  }
}

export async function bounded<T>(work: Promise<T>, ms = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SpikeError('verifier_timeout')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
