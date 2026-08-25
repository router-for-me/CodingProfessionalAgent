var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
import path from 'node:path';
import { fileURLToPath } from 'node:url';
var frontendRoot = path.dirname(fileURLToPath(import.meta.url));
var nm = function () {
    var segments = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        segments[_i] = arguments[_i];
    }
    return path.resolve.apply(path, __spreadArray([frontendRoot, 'node_modules'], segments, false));
};
var zustandEsmRoot = nm('zustand', 'esm');
var zustandShim = path.resolve(frontendRoot, 'src/vendor/zustand.ts');
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
export var frontendResolveAliases = [
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
];
/**
 * Resolve `zustand` to the local shim and `zustand/*` to ESM files before both
 * the dep optimizer and the browser import graph run.
 */
export function zustandEsmResolvePlugin() {
    return {
        name: 'zustand-esm-resolve',
        enforce: 'pre',
        resolveId: function (id) {
            var _a;
            if (id === 'zustand') {
                return zustandShim;
            }
            if (id.startsWith('zustand/')) {
                var sub = (_a = id.slice('zustand/'.length).split('?')[0]) !== null && _a !== void 0 ? _a : '';
                var file = sub.endsWith('.mjs') ? sub : "".concat(sub, ".mjs");
                return path.join(zustandEsmRoot, file);
            }
            return null;
        },
        config: function () {
            return {
                optimizeDeps: {
                    exclude: ['zustand'],
                    esbuildOptions: {
                        plugins: [
                            {
                                name: 'zustand-leave-external',
                                setup: function (build) {
                                    build.onResolve({ filter: /^zustand(\/.*)?$/ }, function (args) { return ({
                                        path: args.path,
                                        external: true,
                                    }); });
                                },
                            },
                        ],
                    },
                },
            };
        },
        configureServer: function (server) {
            server.middlewares.use(function (req, res, next) {
                var _a;
                var url = (_a = req.url) !== null && _a !== void 0 ? _a : '';
                if (!url.includes('/.vite/deps/zustand.js')) {
                    next();
                    return;
                }
                res.setHeader('Content-Type', 'text/javascript');
                res.end("export { create, createStore, useStore } from '/src/vendor/zustand.ts'\n");
            });
        },
    };
}
