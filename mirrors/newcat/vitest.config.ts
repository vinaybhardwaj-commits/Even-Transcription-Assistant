import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NEWCAT_LLM: 'fake',
      NEWCAT_JEV: 'fake',
      NEWCAT_EMBED: 'fake',
    },
  },
})
