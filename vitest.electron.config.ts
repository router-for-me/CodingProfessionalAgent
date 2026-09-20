import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'frontend/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setupHome.ts'],
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
      'plugins/bundled/**/main/**/*.test.ts',
    ],
  },
})

