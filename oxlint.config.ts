import { defineConfig, type OxlintOverride } from 'oxlint'
import { agentIgnorePatterns } from './tools/vendored.ts'

/** Where React runs, and the plugins its files are linted with. */
const REACT_FILES = ['apps/web/**', 'packages/ui/**', 'packages/kit/**', 'packages/app/src/ui/**']
const REACT_PLUGINS: OxlintOverride['plugins'] = ['typescript', 'unicorn', 'oxc', 'import', 'react']
/** The React Compiler's checks of the Rules of React (oxlint's port): refs, purity, effects, memoisation, syntax. */
const RULES_OF_REACT = [
  'refs',
  'purity',
  'immutability',
  'preserve-manual-memoization',
  'set-state-in-render',
  'set-state-in-effect',
  'static-components',
  'use-memo',
  'incompatible-library',
  'unsupported-syntax',
  'globals',
  'error-boundaries',
]

/** What reaches the server from the browser: myapps' list without its extension messaging, plus SSE. */
const TRANSPORT = {
  callees: ['fetch', 'XMLHttpRequest', 'EventSource', 'HttpClient.*', 'HttpApiClient.make', '*.run', '*.callTool'],
}

/**
 * Monorepo lint rules, all at error. Two repository plugins add what generic rules cannot know:
 * - `boundaries` (tools/oxlint/boundaries.ts) enforces tools/graph.ts: declared workspace imports, and runtime-bound
 *   modules (`bun`, `bun:*`, `@effect/platform-bun`, `cloudflare:*`, `node:*`, the `Bun` global) only where the file's
 *   runtime allows them. It replaces the per-directory Bun and `cloudflare:workers` bans. A module a workspace closes
 *   (the runtime's bridge, `promiseWith`) is imported only by the files tools/graph.ts lists for it.
 * - `goblin` (tools/oxlint/goblin.ts) enforces repository invariants from AGENTS.md.
 * Relaxations are targeted overrides, each with its reason (docs/agents/lint-quality.md).
 */
export default defineConfig({
  ignorePatterns: [
    '**/.alchemy/**',
    '**/dist/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/routeTree.gen.ts',
    // Vendored from dmmulroy/anti-slop (tools/oxlint/anti-slop/PROVENANCE.md): upstream code, upstream style.
    'tools/oxlint/anti-slop/**',
    // Vendored skills (from .agents/skills/sources.json) and harness link and state directories.
    ...agentIgnorePatterns(),
  ],
  // Type-aware rules run through oxlint-tsgolint, pinned with TypeScript in package.json. A bare `oxlint`
  // therefore matches CI. `--type-check` is never used: it picks the wrong tsconfig in workspaces with several.
  options: { typeAware: true, reportUnusedDisableDirectives: 'error' },
  jsPlugins: [
    './tools/oxlint/boundaries.ts',
    './tools/oxlint/goblin.ts',
    './tools/oxlint/anti-slop/index.ts',
    './tools/oxlint/anti-slop/effect/index.ts',
    // Cognitive complexity (Sonar's metric); oxlint has no native rule for it.
    'oxlint-plugin-complexity',
    // Design-system rules for the shadcn components in packages/ui (docs/agents/ui.md).
    '@shadcn/lint',
    // TanStack Query and Router usage rules, on the web data layer's paths (docs/agents/lint-quality.md).
    { name: '@tanstack/query', specifier: '@tanstack/eslint-plugin-query' },
    { name: '@tanstack/router', specifier: '@tanstack/eslint-plugin-router' },
  ],
  // Components come from the @goblin/ui barrel. A file's theme is the Tailwind stylesheet of its package (a
  // components.json, where one exists, names it); apps need no components.json of their own.
  settings: { shadcn: { ui: '@goblin/ui' } },
  categories: { correctness: 'error', suspicious: 'error' },
  plugins: ['typescript', 'unicorn', 'oxc', 'import'],
  env: { es2024: true },
  rules: {
    'import/no-unassigned-import': 'off',
    'typescript/no-explicit-any': 'error',
    'no-underscore-dangle': 'off',
    'no-unused-vars': [
      'error',
      { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    // Type-aware rules beyond the categories (the categories already enable await-thenable, no-floating-promises,
    // no-base-to-string, no-misused-spread, restrict-template-expressions, unbound-method,
    // no-unnecessary-type-assertion and the rest of their type-aware rules).
    'typescript/no-misused-promises': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/only-throw-error': [
      'error',
      { allow: [{ from: 'package', name: ['Redirect', 'NotFoundError'], package: '@tanstack/router-core' }] },
    ],
    'typescript/no-deprecated': 'error',
    'typescript/ban-ts-comment': [
      'error',
      { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
    ],
    // Replaced by anti-slop's SAFETY-comment rule: an assertion is allowed when it states its invariant.
    'typescript/no-unsafe-type-assertion': 'off',
    // Off: it flags Effect's `return yield* Effect.fail(...)` (which Effect's missingReturnYieldStar diagnostic
    // requires), exhaustive switches, `process.exit` and React effect cleanups. TypeScript reports a missing return
    // value on its own.
    'typescript/consistent-return': 'off',
    // anti-slop (vendored, trimmed to these rules; tools/oxlint/anti-slop/PROVENANCE.md).
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop-effect/no-manual-tag-comparison': 'error',
    'anti-slop-effect/no-manual-effect-error-tag': 'error',
    // Size and complexity: a file, a function or a nesting level an agent can hold in one read.
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    'max-depth': ['error', 4],
    'max-params': ['error', 5],
    'complexity/complexity': ['error', { cyclomatic: 1000, cognitive: 15 }],
    'boundaries/no-cross-boundary-import': 'error',
    'boundaries/no-closed-import': 'error',
    'boundaries/no-runtime-global': 'error',
    'goblin/no-process-env': 'error',
    'goblin/require-disable-description': 'error',
    // No silent failure, no floating promise, no `any` flowing through.
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
  },
  overrides: [
    // Stack files declare the named Cloudflare resources; their physical names come from the stage (ADR 0002).
    {
      files: ['apps/*/alchemy.run.ts'],
      rules: { 'goblin/resource-name-via-stage': 'error' },
    },
    // process.env is these files' input, not app settings:
    // - the Vite and Vitest configs read the build's and the test harness's settings before anything is bundled;
    // - scripts/stage.ts builds and scrubs the child environment of every stage run (ADR 0001; decision F4 in
    //   docs/agents/lint-quality.md).
    {
      files: ['**/vitest*.config.ts', '**/vite.config.ts', 'scripts/stage.ts'],
      rules: { 'goblin/no-process-env': 'off' },
    },
    // The isolated benchmark stack must replace ambient cloud credentials with local placeholders and restore them.
    { files: ['bench/scripts/local.ts'], rules: { 'goblin/no-process-env': 'off' } },
    // shadcn's design-system rules on the web views and the shadcn package: theme tokens, no raw colours, inline
    // styles, unknown or computed classes, and a component restyled only in its layout. The kit draws with its own
    // stylesheet.
    {
      files: ['apps/web/src/**/*.tsx', 'packages/ui/src/**'],
      rules: {
        'shadcn/no-restyle': ['error', { allow: ['layout'] }],
        'shadcn/no-raw-colors': 'error',
        'shadcn/no-arbitrary-values': ['error', { allow: ['layout'] }],
        'shadcn/no-inline-styles': 'error',
        'shadcn/no-unknown-classes': 'error',
        'shadcn/require-static-classes': 'error',
      },
    },
    // The components own their appearance: they define the styles no-restyle protects and need structural values such
    // as `ring-[3px]` (shadcn/lint's recommended setup). no-raw-colors, no-inline-styles and no-unknown-classes stay on.
    {
      files: ['packages/ui/src/components/**'],
      rules: {
        'shadcn/no-restyle': 'off',
        'shadcn/no-arbitrary-values': 'off',
        'shadcn/require-static-classes': 'off',
      },
    },
    // The web app, the shadcn components, the kit's drawn blocks and the agent app UI are React: enable the react
    // plugin (automatic JSX runtime). Hooks follow their rules and declare their dependencies.
    {
      files: REACT_FILES,
      plugins: REACT_PLUGINS,
      rules: { 'react/react-in-jsx-scope': 'off', 'react/rules-of-hooks': 'error', 'react/exhaustive-deps': 'error' },
    },
    // The Rules of React as the React Compiler checks them, in the source it compiles: a component that breaks one is
    // skipped by it. Test fixtures count renders and poke at refs on purpose.
    {
      files: ['apps/web/src/**', 'packages/ui/src/**', 'packages/kit/src/**', 'packages/app/src/ui/**'],
      plugins: REACT_PLUGINS,
      rules: Object.fromEntries(RULES_OF_REACT.map((rule) => [`react/${rule}`, 'error'])),
    },
    // `any` is banned everywhere. In shipped code (src, app, entrypoints) the unsafe rules also keep an inferred `any`
    // from flowing through; tests and one-shot tooling (scripts, config files) poke at untyped JSON, provider responses
    // and mocks, where an inferred `any` is the honest type.
    {
      files: [
        '**/test/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.config.ts',
        'scripts/**',
        'bench/scripts/**',
        'spikes/**/scripts/**',
      ],
      rules: {
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    // Test files: a `describe` block is the file's outline, not a function to split, and table-driven suites run
    // long. They still have a size limit.
    {
      files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'max-lines-per-function': 'off',
        'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
      },
    },
    // `console` is the interface of the CLI, tooling, operator, build and spike scripts, and tests; the runtime writes
    // through its logger.
    {
      files: [
        'apps/runtime/src/observability/logger.ts',
        'apps/cli/**',
        'tools/**',
        'scripts/**',
        'bench/scripts/**',
        'packages/*/scripts/**',
        'spikes/**/scripts/**',
        '**/test/**',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
      rules: { 'no-console': 'off' },
    },
    // The web data layer (tools/oxlint/data-invariants.ts): server data comes through the typed client in query and
    // mutation factories, effects start no network work, views read the Query cache, and Query and Router are used as
    // their plugins require.
    {
      files: ['apps/web/src/**'],
      rules: {
        'goblin/no-transport-outside-client': ['error', TRANSPORT],
        'goblin/no-network-in-effect': ['error', TRANSPORT],
        'goblin/no-loader-data': ['error', { mode: 'all' }],
        '@tanstack/query/exhaustive-deps': 'error',
        '@tanstack/query/no-rest-destructuring': 'error',
        '@tanstack/query/stable-query-client': 'error',
        '@tanstack/query/no-unstable-deps': 'error',
        '@tanstack/query/prefer-query-options': 'error',
        '@tanstack/query/mutation-property-order': 'error',
        '@tanstack/router/create-route-property-order': 'error',
        '@tanstack/router/route-param-names': 'error',
      },
    },
    // The transport modules: the typed client (lib/api*.ts) and its query bridge (lib/query/), each feature's query
    // factories (queries.ts); the owner's file bytes, which the JSON API does not carry (lib/files.ts); and the
    // EventSource streams (lib/conversation-stream.ts), which feed the views and invalidate query keys.
    {
      files: [
        'apps/web/src/lib/api*.ts',
        'apps/web/src/lib/query/**',
        'apps/web/src/**/queries.ts',
        'apps/web/src/lib/files.ts',
        'apps/web/src/lib/conversation-stream.ts',
      ],
      rules: { 'goblin/no-transport-outside-client': 'off' },
    },
  ],
})
