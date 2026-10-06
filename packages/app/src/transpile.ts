// The transpiler of agent app sources, run in a Dynamic Worker of its own (ADR 0021). sucrase strips TypeScript and
// keeps line numbers, so a runtime stack points at the line the agent wrote. Imports are checked here: the server side
// imports only `@goblin/app` and its own files, which become `./<name>.js` modules side by side; the view (`view.tsx`)
// becomes one CommonJS module that requires only what its frame provides.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { transform } from 'sucrase'

/** A problem in one of the app's files, with the line when it is known. */
export type Diagnostic = { readonly file: string; readonly line?: number; readonly message: string }
/**
 * The server modules and the view's module ('' without a view) with the frame bundles it needs, when there are no
 * diagnostics.
 */
type Transpiled = {
  readonly modules: Readonly<Record<string, string>>
  readonly view: string
  readonly libs: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
}

const ALLOWED = new Set(['@goblin/app'])
const SOURCE = /^[a-z][a-z0-9-]{0,31}\.(?:ts|js)$/u
const VIEW = 'view.tsx'
/** What a view may require, and the frame bundle that provides it besides the core (null: the core). */
const VIEW_IMPORTS: Readonly<Record<string, string | null>> = {
  react: null,
  'react/jsx-runtime': null,
  '@goblin/app': null,
  '@goblin/ui': null,
  '@goblin/kit/chart': 'charts',
  recharts: 'charts',
  '@goblin/kit/map': 'maps',
  'react-leaflet': 'maps',
  leaflet: 'maps',
  '@goblin/kit/diagram': 'diagrams',
  'lucide-react': 'icons',
}
const REQUIRE = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/gu
const SPECIFIER = /(\b(?:import|export)\b[^'"`;]*?\bfrom\s*|\bimport\s*)(['"])([^'"\n]+)\2/gu
const DYNAMIC = /\bimport\s*\(/gu

const stem = (file: string) => file.replace(/\.(?:ts|js)$/u, '')
const lineAt = (code: string, index: number) => code.slice(0, index).split('\n').length

/** The line and column sucrase puts at the end of a syntax error's message, as "(line:column)". */
function syntaxLine(message: string): number | undefined {
  const match = /\((\d+):\d+\)\s*$/u.exec(message)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

function linked(file: string, code: string, stems: ReadonlySet<string>, diagnostics: Diagnostic[]): string {
  for (const match of code.matchAll(DYNAMIC))
    diagnostics.push({ file, line: lineAt(code, match.index), message: 'import() is not available in an app.' })
  return code.replaceAll(SPECIFIER, (whole, head: string, quote: string, specifier: string, index: number) => {
    if (ALLOWED.has(specifier)) return whole
    const local = /^\.\/([a-z][a-z0-9-]{0,31})(?:\.(?:ts|js))?$/u.exec(specifier)?.[1]
    if (local !== undefined && stems.has(local)) return `${head}${quote}./${local}.js${quote}`
    diagnostics.push({
      file,
      line: lineAt(code, index),
      message: `Cannot import "${specifier}": an app imports only @goblin/app and its own files ("./name").`,
    })
    return whole
  })
}

/** One file as a module, or its syntax error. */
function transpiled(file: string, source: string, stems: ReadonlySet<string>, diagnostics: Diagnostic[]): string {
  try {
    const { code } = transform(source, {
      transforms: file.endsWith('.ts') ? ['typescript'] : [],
      disableESTransforms: true,
      production: true,
      filePath: file,
    })
    return linked(file, code, stems, diagnostics)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const line = syntaxLine(message)
    diagnostics.push({ file, ...(line === undefined ? {} : { line }), message })
    return ''
  }
}

/**
 * The view as one CommonJS module with React's automatic JSX runtime, and the frame bundles its requires need. Its
 * imports of types (from `./app`, say) disappear; anything else outside the frame's modules is a problem.
 */
function viewModule(source: string, diagnostics: Diagnostic[]): { readonly code: string; readonly libs: string[] } {
  let code: string
  try {
    code = transform(source, {
      transforms: ['typescript', 'jsx', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
      filePath: VIEW,
    }).code
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const line = syntaxLine(message)
    diagnostics.push({ file: VIEW, ...(line === undefined ? {} : { line }), message })
    return { code: '', libs: [] }
  }
  for (const match of code.matchAll(DYNAMIC))
    diagnostics.push({ file: VIEW, line: lineAt(code, match.index), message: 'import() is not available in a view.' })
  const libs = new Set<string>()
  for (const match of code.matchAll(REQUIRE)) {
    const name = match[2] ?? ''
    const lib = VIEW_IMPORTS[name]
    if (lib === undefined)
      diagnostics.push({
        file: VIEW,
        line: lineAt(code, match.index),
        message: `Cannot import "${name}" in the view: it imports ${Object.keys(VIEW_IMPORTS).join(', ')}, and types from its app.`,
      })
    else if (lib !== null) libs.add(lib)
  }
  return { code, libs: [...libs].toSorted() }
}

const failed = (diagnostics: readonly Diagnostic[]): Transpiled => ({ modules: {}, view: '', libs: [], diagnostics })

export class Transpile extends WorkerEntrypoint {
  /** The app's files as modules named `<name>.js` and its view, and every problem found (none when it worked). */
  transpile(files: Readonly<Record<string, string>>): Transpiled {
    const { [VIEW]: viewSource, ...server } = files
    const names = Object.keys(server)
    const diagnostics: Diagnostic[] = names
      .filter((file) => !SOURCE.test(file))
      .map((file) => ({ file, message: 'File names are lowercase, like app.ts or lib.ts; the UI is view.tsx.' }))
    if (diagnostics.length > 0) return failed(diagnostics)
    const stems = new Set(names.map(stem))
    const modules = Object.fromEntries(
      Object.entries(server).map(([file, source]) => [
        `${stem(file)}.js`,
        transpiled(file, source, stems, diagnostics),
      ]),
    )
    const view = viewSource === undefined ? { code: '', libs: [] } : viewModule(viewSource, diagnostics)
    return diagnostics.length > 0 ? failed(diagnostics) : { modules, view: view.code, libs: view.libs, diagnostics }
  }
}

export default {}
