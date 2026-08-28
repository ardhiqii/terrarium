import { defineConfig } from 'vitest/config'
import path from 'path'

const rootDir = import.meta.dirname

export default defineConfig({
  test: {
    environment: 'node',
    include: ['web/src/**/*.test.ts', 'extension/**/*.test.js'],
  },
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './web/src'),
    },
  },
})
