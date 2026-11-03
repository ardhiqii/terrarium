import { defineConfig } from 'vitest/config'
import path from 'path'

const rootDir = import.meta.dirname

export default defineConfig({
  test: {
    environment: 'node',
    // `.test.tsx` is where a component is actually rendered (`renderToStaticMarkup`, no DOM
    // needed). Every other component test reads its own source as a string and cannot fail
    // for a behavioural reason.
    include: ['apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx', 'apps/extension/**/*.test.js'],
  },
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './apps/web/src'),
    },
  },
})
