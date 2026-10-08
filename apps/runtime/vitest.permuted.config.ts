import { defineConfig } from 'vitest/config'
import integration from './vitest.integration.config.ts'

/** Rerun the real owner, helper, routine, Telegram and memory cases on a non-root primary binding. */
export default defineConfig({
  test: {
    ...integration.test,
    include: ['test/integration/native.test.ts', 'test/integration/owner.test.ts'],
    env: { ...integration.test?.env, GOBLIN_PRIMARY_PROFILE: 'permuted' },
  },
})
