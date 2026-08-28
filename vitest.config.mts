import { defineConfig } from 'vitest/config'
import path from 'path'

const rootDir = import.meta.dirname

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/web/src/**/*.test.ts', 'apps/extension/**/*.test.js'],
  },
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './apps/web/src'),
    },
  },
})
