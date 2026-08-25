import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const frontendRoot = path.dirname(fileURLToPath(import.meta.url))
const nm = (...segments: string[]) => path.resolve(frontendRoot, 'node_modules', ...segments)
const zustandEsmRoot = nm('zustand', 'esm')
const zustandShim = path.resolve(frontendRoot, 'src/vendor/zustand.ts')

/**
 * Shared Vite/Vitest aliases for frontend + bundled plugins outside `frontend/`.
 *
 * Do not alias `zustand` to its package directory. @rollup/plugin-alias treats a
 * string/directory alias as a prefix, so `zustand/vanilla` resolves to CJS files.
 * Vite then prebundles `/node_modules/.vite/deps/zustand.js` without a named
 * `create` export and the renderer dies on first paint (`#startup-splash` stays).
 *
 * Point the bare specifier at a first-party shim so Vite never treats `zustand`
 * as an optimized node_modules dependency.
 */
export const frontendResolveAliases: Array<{ find: string | RegExp; replacement: string }> = [
    { find: '@', replacement: path.resolve(frontendRoot, 'src') },
    { find: '@shared', replacement: path.resolve(frontendRoot, '../src/shared') },
    { find: '@tanstack/react-router', replacement: nm('@tanstack', 'react-router') },
    { find: '@xterm/xterm', replacement: nm('@xterm', 'xterm') },
    { find: '@xterm/addon-fit', replacement: nm('@xterm', 'addon-fit') },
    { find: 'diff', replacement: nm('diff') },
    { find: 'yaml', replacement: nm('yaml') },
    { find: 'ignore', replacement: nm('ignore') },
    { find: /^zustand$/, replacement: zustandShim },
    { find: /^zustand\/(.*)$/, replacement: path.join(zustandEsmRoot, '$1.mjs') },
    { find: 'lucide-react', replacement: nm('lucide-react') },
]

/**
 * Resolve `zustand` to the local shim and `zustand/*` to ESM files before both
 * the dep optimizer and the browser import graph run.
 */
export function zustandEsmResolvePlugin(): Plugin {
    return {
        name: 'zustand-esm-resolve',
        enforce: 'pre',
        resolveId(id) {
            if (id === 'zustand') {
                return zustandShim
            }
            if (id.startsWith('zustand/')) {
                const sub = id.slice('zustand/'.length).split('?')[0] ?? ''
                const file = sub.endsWith('.mjs') ? sub : `${sub}.mjs`
                return path.join(zustandEsmRoot, file)
            }
            return null
        },
        config() {
            return {
                optimizeDeps: {
                    exclude: ['zustand'],
                    esbuildOptions: {
                        plugins: [
                            {
                                name: 'zustand-leave-external',
                                setup(build) {
                                    build.onResolve({ filter: /^zustand(\/.*)?$/ }, (args) => ({
                                        path: args.path,
                                        external: true,
                                    }))
                                },
                            },
                        ],
                    },
                },
            }
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url ?? ''
                if (!url.includes('/.vite/deps/zustand.js')) {
                    next()
                    return
                }
                res.setHeader('Content-Type', 'text/javascript')
                res.end("export { create, createStore, useStore } from '/src/vendor/zustand.ts'\n")
            })
        },
    }
}
