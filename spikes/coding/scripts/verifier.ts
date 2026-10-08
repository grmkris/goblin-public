import { API, DiagnosticCategory, type Diagnostic } from '../node_modules/typescript/dist/api/async/api.js'
import { readdirSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { Lsp, bounded } from './lsp.ts'
import { SpikeError, type Check, type Overlay } from './overlay.ts'

const configs = ['apps/cli/tsconfig.json']

/** One compiler pair and LSP pair per session; the baseline and trusted configuration never change. */
export class Verifier {
  readonly types: API
  readonly effects: API
  readonly previous = new Set<string>()
  lint: Lsp | undefined
  fmt: Lsp | undefined
  initialized = false
  constructor(
    readonly root: string,
    readonly overlay: Overlay,
    effectBinary: string,
    typeBinary?: string,
  ) {
    const fs = {
      readFile: (name: string) => overlay.changes.get(path.relative(root, name)),
      fileExists: (name: string) => (overlay.changes.has(path.relative(root, name)) ? true : undefined),
      getAccessibleEntries: (name: string) => this.entries(name),
    }
    this.types = new API({ cwd: root, fs, ...(typeBinary ? { tsserverPath: typeBinary } : {}) })
    this.effects = new API({ cwd: root, tsserverPath: effectBinary, fs })
  }

  private entries(directory: string) {
    const additions = [...this.overlay.changes.keys()]
      .map((file) => path.relative(directory, path.join(this.root, file)))
      .filter((file) => !file.startsWith('..') && !path.isAbsolute(file))
    if (additions.length === 0) return undefined
    let existing: Dirent[]
    try {
      existing = readdirSync(directory, { withFileTypes: true })
    } catch {
      existing = []
    }
    const files = new Set(existing.filter((entry) => entry.isFile()).map((entry) => entry.name))
    const directories = new Set(existing.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    for (const file of additions) {
      const [first] = file.split(path.sep)
      if (first && file.includes(path.sep)) directories.add(first)
      else if (first) files.add(first)
    }
    return { files: [...files], directories: [...directories] }
  }

  private async compiler(api: API, source: string): Promise<unknown[]> {
    const changes = [...new Set([...this.previous, ...this.overlay.changes.keys()])].map((file) =>
      path.join(this.root, file),
    )
    const snapshot = await api.updateSnapshot({
      ...(!this.initialized ? { openProjects: configs.map((file) => path.join(this.root, file)) } : {}),
      fileChanges: {
        changed: changes,
        created: changes.filter(
          (file) =>
            this.overlay.changes.has(path.relative(this.root, file)) &&
            !this.overlay.files.has(path.relative(this.root, file)),
        ),
        deleted: changes.filter(
          (file) =>
            !this.overlay.changes.has(path.relative(this.root, file)) &&
            !this.overlay.files.has(path.relative(this.root, file)),
        ),
      },
    })
    try {
      const diagnostics: Diagnostic[] = []
      for (const config of configs) {
        const project = snapshot.getProject(path.join(this.root, config))
        if (!project) throw new SpikeError('unchecked_project')
        diagnostics.push(
          ...(await project.program.getConfigFileParsingDiagnostics()),
          ...(await project.program.getProgramDiagnostics()),
          ...(await project.program.getGlobalDiagnostics()),
          ...(await project.program.getSyntacticDiagnostics()),
          ...(await project.program.getSemanticDiagnostics()),
        )
      }
      return diagnostics
        .filter((item) => item.category === DiagnosticCategory.Error)
        .map((item) => ({
          source,
          file: item.fileName ? path.relative(this.root, item.fileName) : undefined,
          code: item.code,
          message: item.text,
        }))
    } finally {
      await snapshot.dispose()
    }
  }

  async ready(): Promise<Check> {
    const start = performance.now()
    this.lint ??= await bounded(Lsp.open(this.root, 'oxlint'))
    this.fmt ??= await bounded(Lsp.open(this.root, 'oxfmt'))
    for (const file of this.previous) {
      if (this.overlay.changes.has(file)) continue
      const original = this.overlay.files.get(file)
      if (original !== undefined) await bounded(this.lint.document(file, original))
      else await bounded(this.lint.forget(file))
    }
    for (const [file, content] of this.overlay.changes) await bounded(this.lint.document(file, content))
    const diagnostics = [
      ...(await bounded(this.compiler(this.types, 'typescript'))),
      ...(await bounded(this.compiler(this.effects, 'effect'))),
    ]
    this.initialized = true
    for (const [file, content] of this.overlay.changes) {
      diagnostics.push(...(await bounded(this.lint.lint(file, content))))
      const formatted = await bounded(this.fmt.format(file, content))
      if (formatted !== content)
        diagnostics.push({
          source: 'oxfmt',
          file,
          message: 'Formatting differs. Replace this file with formattedContent.',
          formattedContent: formatted,
        })
    }
    this.previous.clear()
    for (const file of this.overlay.changes.keys()) this.previous.add(file)
    return {
      revision: this.overlay.revision,
      passed: diagnostics.length === 0,
      diagnostics,
      elapsedMs: Math.round(performance.now() - start),
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.types.close(), this.effects.close(), this.lint?.close(), this.fmt?.close()])
  }
}
