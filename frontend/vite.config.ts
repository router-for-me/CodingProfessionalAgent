import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { frontendResolveAliases, zustandEsmResolvePlugin } from './vite.aliases'

export default defineConfig({
  base: './',
  plugins: [zustandEsmResolvePlugin(), react(), tailwindcss()],
  resolve: {
    alias: frontendResolveAliases,
    dedupe: ['zustand', 'react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['zustand'],
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: false,
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18080',
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', '../plugins/bundled/**/*.test.{ts,tsx}'],
    globals: true,
    passWithNoTests: true,
  },
})
