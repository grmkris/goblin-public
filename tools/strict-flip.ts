/**
 * The final flip of the strict lint set (docs/agents/lint-quality.md), run once at integration:
 *
 *   bun tools/strict-flip.ts            check that every edit applies; nothing is written
 *   bun tools/strict-flip.ts --apply    write the edits, delete tools/strict/ and this script with its test
 *
 * - oxlint.config.ts: the strict rules go to the top level and `react/exhaustive-deps` to every React file; the web
 *   data layer covers all of apps/web/src; `no-console` stays allowed only in the runtime logger, apps/cli, tools,
 *   scripts, bench/scripts and tests.
 * - tsconfig.base.json: `extendsNativeError` and `catchUnfailableEffect` are errors.
 * - knip.jsonc: configuration hints are errors.
 * - docs/agents/lint-quality.md says so.
 * Each edit names the exact text it replaces; when one is missing nothing is written. After `--apply`,
 * `bun run lint:report` lists the files still to fix before the flip is committed.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bin, repoRoot, run } from './run.ts'

export interface Edit {
  readonly from: string
  readonly to: string
}

/** `text` with each edit made once; each `from` must occur exactly once in the text it is applied to. */
export const applyEdits = (file: string, text: string, edits: readonly Edit[]): string =>
  edits.reduce((current, { from, to }) => {
    const occurrences = current.split(from).length - 1
    if (occurrences !== 1) {
      throw new Error(`${file}: expected one occurrence of ${JSON.stringify(from.slice(0, 80))}, found ${occurrences}`)
    }
    return current.replace(from, () => to)
  }, text)

const STRICT_IMPORTS = `import { STRICT_PATHS, STRICT_REACT_PATHS, STRICT_REACT_RULES, STRICT_RULES } from './tools/strict/index.ts'
import { paths as w1 } from './tools/strict/w1.ts'
import { paths as w2 } from './tools/strict/w2.ts'
import { paths as w3 } from './tools/strict/w3.ts'
`

/** Where `console` is the interface: the runtime's one logger, the CLI, tooling, operator scripts and tests. */
export const CONSOLE_ALLOWED = [
  'apps/runtime/src/observability/logger.ts',
  'apps/cli/**',
  'tools/**',
  'scripts/**',
  'bench/scripts/**',
  '**/test/**',
  '**/tests/**',
  '**/*.test.ts',
  '**/*.test.tsx',
]

export const OXLINT_EDITS: readonly Edit[] = [
  { from: STRICT_IMPORTS, to: '' },
  {
    from: `/** The web app's source among the web lanes' strict paths: the data-layer rules apply where a lane has opted in. */
const WEB_DATA_PATHS = [...w1, ...w2, ...w3].filter((glob) => glob.startsWith('apps/web/src/'))
`,
    to: '',
  },
  {
    from: ` * Relaxations are targeted overrides, each with its reason (docs/agents/lint-quality.md). The strict set
 * (tools/strict/) applies to the files each lane has made pass it; a strict rule with no finding anywhere is on for
 * every file.
`,
    to: ` * Relaxations are targeted overrides, each with its reason (docs/agents/lint-quality.md).
`,
  },
  {
    from: `    // Strict rules (tools/strict/index.ts) that no file breaks any more.
    'no-empty': 'error',
    'prefer-promise-reject-errors': 'error',
`,
    to: `    // No silent failure, no floating promise, no \`any\` flowing through.
    'no-console': 'error',
    'no-empty': 'error',
    'prefer-promise-reject-errors': 'error',
    'goblin/no-silent-catch': 'error',
    'typescript/use-unknown-in-catch-callback-variable': 'error',
    'typescript/no-floating-promises': ['error', { ignoreVoid: false }],
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-assignment': 'error',
    'typescript/no-unsafe-call': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-return': 'error',
`,
  },
  {
    from: `Hooks follow their rules everywhere; exhaustive-deps is still strict-only.
    {
      files: REACT_FILES,
      plugins: REACT_PLUGINS,
      rules: { 'react/react-in-jsx-scope': 'off', 'react/rules-of-hooks': 'error' },`,
    to: `Hooks follow their rules and declare their dependencies.
    {
      files: REACT_FILES,
      plugins: REACT_PLUGINS,
      rules: { 'react/react-in-jsx-scope': 'off', 'react/rules-of-hooks': 'error', 'react/exhaustive-deps': 'error' },`,
  },
  {
    from: `    // The strict set, last so no relaxation above undoes it (docs/agents/lint-quality.md).
    { files: [...STRICT_PATHS], rules: STRICT_RULES },
    ...(STRICT_REACT_PATHS.length === 0
      ? []
      : [{ files: [...STRICT_REACT_PATHS], plugins: REACT_PLUGINS, rules: STRICT_REACT_RULES }]),
`,
    to: `    // \`console\` is the interface of the CLI, tooling, operator scripts and tests; the runtime writes through its logger.
    { files: ${JSON.stringify(CONSOLE_ALLOWED)}, rules: { 'no-console': 'off' } },
`,
  },
  { from: "their plugins require. On the web lanes' strict paths.\n", to: 'their plugins require.\n' },
  {
    from: `    ...(WEB_DATA_PATHS.length === 0
      ? []
      : [
          {
            files: WEB_DATA_PATHS,
`,
    to: `    {
            files: ['apps/web/src/**'],
`,
  },
  {
    from: `          } satisfies OxlintOverride,
        ]),
`,
    to: `          },
`,
  },
]

export const TSCONFIG_EDITS: readonly Edit[] = [
  {
    from: `          "runEffectInsideEffect": "error",
`,
    to: `          "runEffectInsideEffect": "error",
          // Errors are tagged classes, and a handler on an Effect that cannot fail is dead code.
          "extendsNativeError": "error",
          "catchUnfailableEffect": "error",
`,
  },
]

export const KNIP_EDITS: readonly Edit[] = [
  { from: '"treatConfigHintsAsErrors": false,', to: '"treatConfigHintsAsErrors": true,' },
]

export const DOC_EDITS: readonly Edit[] = [
  {
    from: "apply to the web lanes' strict paths under `apps/web/src/`.",
    to: 'apply to `apps/web/src/`.',
  },
  {
    from: 'configuration hints are reported but do not fail. `treatConfigHintsAsErrors` in `knip.jsonc` is the switch: knip then exits 1 for hints, and',
    to: 'configuration hints fail too (`treatConfigHintsAsErrors` in `knip.jsonc`): knip exits 1 for them, and',
  },
  {
    from: 'Effect diagnostics cover every typechecked project; an incomplete tool or unchecked project is a failure.',
    to: 'Effect diagnostics cover every typechecked project; an incomplete tool or unchecked project is a failure. `extendsNativeError` and `catchUnfailableEffect` are errors.',
  },
]

/** The strict-set paragraph, from its first words to the end of its line. */
const STRICT_PARAGRAPH = /^The strict set in `tools\/strict\/index\.ts` is frozen:.*$/mu
const STRICT_NOW =
  'The strict rules are on for every file: `no-console` (off only in the runtime logger, `apps/cli`, `tools`, `scripts`, `bench/scripts` and tests), `no-empty`, `prefer-promise-reject-errors`, `goblin/no-silent-catch`, `typescript/use-unknown-in-catch-callback-variable`, `typescript/no-floating-promises` without the `void` escape and the five `typescript/no-unsafe-*` rules; every React file (`apps/web`, `packages/ui`, `packages/kit`, `packages/app/src/ui`) also runs `react/rules-of-hooks` and `react/exhaustive-deps`.'

/** The documentation edits, the strict-set paragraph included. */
export const flipDoc = (text: string): string => {
  const edited = applyEdits('docs/agents/lint-quality.md', text, DOC_EDITS)
  if (!STRICT_PARAGRAPH.test(edited)) throw new Error('docs/agents/lint-quality.md: the strict-set paragraph is gone')
  return edited.replace(STRICT_PARAGRAPH, STRICT_NOW)
}

/** Each file the flip rewrites, with its rewrite. */
export const FLIPS: ReadonlyArray<readonly [string, (text: string) => string]> = [
  ['oxlint.config.ts', (text) => applyEdits('oxlint.config.ts', text, OXLINT_EDITS)],
  ['tsconfig.base.json', (text) => applyEdits('tsconfig.base.json', text, TSCONFIG_EDITS)],
  ['knip.jsonc', (text) => applyEdits('knip.jsonc', text, KNIP_EDITS)],
  ['docs/agents/lint-quality.md', flipDoc],
]

/** What the flip deletes: the strict set and this one-shot script. */
const DELETED = ['tools/strict', 'tools/strict-flip.ts', 'tools/test/strict-flip.test.ts']

const main = async (apply: boolean): Promise<void> => {
  const written = FLIPS.map(([file, flip]) => {
    const absolute = path.join(repoRoot, file)
    return [absolute, flip(readFileSync(absolute, 'utf8'))] as const
  })
  if (!apply) {
    console.info(`strict-flip: all ${written.length} files apply; run with --apply to write them`)
    return
  }
  for (const [absolute, text] of written) writeFileSync(absolute, text)
  for (const file of DELETED) rmSync(path.join(repoRoot, file), { recursive: true })
  const format = await run([bin('oxfmt'), '-c', 'oxfmt.config.ts', '--write', ...FLIPS.map(([file]) => file)])
  if (format.exitCode !== 0) throw new Error(`oxfmt exited ${format.exitCode}\n${format.stderr}`)
  console.info('strict-flip: written. Next: `bun run lint:report`, fix what it lists, then `bun run check`.')
}

if (import.meta.main) await main(Bun.argv.includes('--apply'))
