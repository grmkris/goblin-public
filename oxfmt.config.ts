import { defineConfig } from 'oxfmt'
import { agentIgnorePatterns } from './tools/vendored.ts'
export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 120,
  ignorePatterns: [
    '.turbo/**',
    '**/.turbo/**',
    '**/.alchemy/**',
    '**/dist/**',
    '**/.output/**',
    '**/.tanstack/**',
    'bun.lock',
    '**/routeTree.gen.ts',
    '**/migrations/**',
    'docs/**',
    'evidence/**',
    '**/__snapshots__/**',
    'tools/oxlint/anti-slop/**',
    ...agentIgnorePatterns(),
  ],
})
