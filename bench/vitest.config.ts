import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/native.test.ts', 'test/transcript-index.test.ts'] },
})
