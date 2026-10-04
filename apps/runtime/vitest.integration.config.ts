import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    env: {
      CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000',
      CLOUDFLARE_API_TOKEN: 'local-placeholder-token',
      ALCHEMY_PLAIN: '1',
      PURRABLE_HARNESS_PORT: process.env['PURRABLE_HARNESS_PORT'] ?? '18861',
    },
  },
})
