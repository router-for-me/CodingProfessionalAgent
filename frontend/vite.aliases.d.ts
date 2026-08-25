import type { Plugin } from 'vite';
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
export declare const frontendResolveAliases: Array<{
    find: string | RegExp;
    replacement: string;
}>;
/**
 * Resolve `zustand` to the local shim and `zustand/*` to ESM files before both
 * the dep optimizer and the browser import graph run.
 */
export declare function zustandEsmResolvePlugin(): Plugin;
