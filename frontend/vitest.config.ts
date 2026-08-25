import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { frontendResolveAliases, zustandEsmResolvePlugin } from './vite.aliases'

export default defineConfig({
  plugins: [zustandEsmResolvePlugin(), react()],
  resolve: {
    alias: [
      ...frontendResolveAliases,
      { find: '@testing-library/react', replacement: path.resolve(__dirname, 'node_modules/@testing-library/react') },
      { find: '@testing-library/user-event', replacement: path.resolve(__dirname, 'node_modules/@testing-library/user-event') },
    ],
    dedupe: ['zustand', 'react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'src/**/*.test.{ts,tsx}',
      '../plugins/bundled/**/renderer/**/*.test.{ts,tsx}',
      '../plugins/bundled/**/agent/**/*.test.{ts,tsx}',
    ],
    globals: true,
    passWithNoTests: true,
  },
})
