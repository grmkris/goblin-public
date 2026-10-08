import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    // Each file boots the same isolated local stack; retire one before the next binds it.
    fileParallelism: false,
    include: ['test/native.test.ts', 'test/transcript-index.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
