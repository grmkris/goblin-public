import { defineConfig } from 'oxlint'
import { agentIgnorePatterns } from './tools/vendored.ts'

/**
 * Monorepo lint rules, all at error. Two repository plugins add what generic rules cannot know:
 * - `boundaries` (tools/oxlint/boundaries.ts) enforces tools/graph.ts: declared workspace imports, and runtime-bound
 *   modules (`bun`, `bun:*`, `@effect/platform-bun`, `cloudflare:*`, `node:*`, the `Bun` global) only where the file's
 *   runtime allows them. It replaces the per-directory Bun and `cloudflare:workers` bans.
 * - `purrable` (tools/oxlint/purrable.ts) enforces repository invariants from AGENTS.md.
 * Relaxations are targeted overrides, each with its reason (docs/agents/lint-quality.md).
 */
export default defineConfig({
  ignorePatterns: [
    '**/.alchemy/**',
    '**/dist/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/routeTree.gen.ts',
    'docs/archive/**',
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
    './tools/oxlint/purrable.ts',
    './tools/oxlint/anti-slop/index.ts',
    './tools/oxlint/anti-slop/effect/index.ts',
    // Cognitive complexity (Sonar's metric); oxlint has no native rule for it.
    'oxlint-plugin-complexity',
    // Design-system rules for the shadcn components in packages/ui (docs/agents/ui.md).
    '@shadcn/lint',
  ],
  // Components come from the @purrable/ui barrel. A file's theme is the Tailwind stylesheet of its package (a
  // components.json, where one exists, names it); apps need no components.json of their own.
  settings: { shadcn: { ui: '@purrable/ui' } },
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
    'boundaries/no-runtime-global': 'error',
    'purrable/no-process-env': 'error',
    'purrable/require-disable-description': 'error',
  },
  overrides: [
    // Stack files declare the named Cloudflare resources; their physical names come from the stage (ADR 0002).
    {
      files: ['alchemy.run.ts', 'apps/*/alchemy.run.ts'],
      rules: { 'purrable/resource-name-via-stage': 'error' },
    },
    // process.env is these files' input, not app settings:
    //   extension origin before anything is bundled;
    // - test/support wires the harness to its ports and evidence directory (docs/agents/testing-harness.md);
    // - scripts/stage.ts builds and scrubs the child environment of every stage run (ADR 0001; decision F4 in
    //   docs/agents/lint-rollout.md).
    {
      files: ['**/vitest*.config.ts', '**/vite.config.ts', '**/test/support/**', 'scripts/stage.ts'],
      rules: { 'purrable/no-process-env': 'off' },
    },
    // nested package CSS import, which the plugin does not follow.
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
    // The three TanStack apps and the myinbox UI are React: enable the react plugin (automatic JSX runtime).
    {
      files: ['apps/web/**', 'packages/ui/**'],
      plugins: ['typescript', 'unicorn', 'oxc', 'import', 'react'],
      rules: { 'react/react-in-jsx-scope': 'off' },
    },
    // `any` is banned in shipped code (src, app, entrypoints). Tests, fixtures and one-shot tooling (scripts, deploy)
    // poke at untyped JSON, provider responses and mocks, where `any` is the honest type.
    {
      files: [
        '**/test/**',
        '**/tests/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        'apps/*/scripts/**',
        'apps/*/deploy/**',
        'apps/*/fixtures/**',
      ],
      rules: { 'typescript/no-explicit-any': 'off' },
    },
    // Test files: a `describe` block is the file's outline, not a function to split, and table-driven suites run
    // long. They still have a size limit.
    {
      files: ['**/test/**', '**/tests/**', '**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'max-lines-per-function': 'off',
        'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
      },
    },
  ],
})
