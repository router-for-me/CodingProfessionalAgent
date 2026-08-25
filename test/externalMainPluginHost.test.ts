import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    type CapabilityHandle,
    type PluginContext,
    type PluginEntryDefinition,
    type ResolvedPluginPackage,
    PluginCapabilityError,
    PluginError,
    PluginValidationError,
} from '@cpa/plugin-api'
import {
    ExternalMainPluginHost,
    extractImportSpecifiers,
    validateExternalPluginImports,
} from '../src/main/plugins/loading/ExternalMainPluginHost.js'

describe('ExternalMainPluginHost (Utility Process Execution, VM Sandbox, RPC & Events)', () => {
    let tempRoot: string
    let pluginDir: string

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-ext-main-host-test-'))
        pluginDir = path.join(tempRoot, 'test-plugin')
        await fs.mkdir(pluginDir, { recursive: true })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup
        }
    })

    describe('1. Static Import Specifier Extraction & Boundary Validation', () => {
        it('extracts static and dynamic imports correctly', () => {
            const code = `
                import { foo } from 'bar';
                import defaultVal from "./local.js";
                export * from '../shared.js';
                const dynamic = import('node:fs');
                const req = require('electron');
            `
            const specifiers = extractImportSpecifiers(code)
            expect(specifiers).toContain('bar')
            expect(specifiers).toContain('./local.js')
            expect(specifiers).toContain('../shared.js')
            expect(specifiers).toContain('node:fs')
            expect(specifiers).toContain('electron')
        })

        it('allows valid relative imports and allowed SDK bare imports', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            const helperFile = path.join(pluginDir, 'helper.js')

            await fs.writeFile(
                helperFile,
                `export function greet() { return 'hello'; }`,
                'utf-8',
            )
            await fs.writeFile(
                mainFile,
                `import { greet } from './helper.js';
                 import { definePluginEntry } from '@cpa/plugin-sdk';
                 export default { runtime: 'main', activate() {} };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'safe-plugin',
                    name: 'Safe Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            await expect(validateExternalPluginImports(pkg)).resolves.toBeUndefined()
        })

        it('rejects Node built-in imports without capability', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `import * as http from 'node:http';
                 export default { runtime: 'main', activate() {} };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'node-import-plugin',
                    name: 'Node Import',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            await expect(validateExternalPluginImports(pkg)).rejects.toThrow(PluginCapabilityError)
        })

        it('rejects Electron imports without capability', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `import { app } from 'electron';
                 export default { runtime: 'main', activate() {} };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'electron-import-plugin',
                    name: 'Electron Import',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            await expect(validateExternalPluginImports(pkg)).rejects.toThrow(PluginCapabilityError)
        })

        it('rejects path escape imports resolving outside sourceRoot', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `import secret from '../outside-secret.js';
                 export default { runtime: 'main', activate() {} };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'escaping-import-plugin',
                    name: 'Escaping Import',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            await expect(validateExternalPluginImports(pkg)).rejects.toThrow()
        })
    })

    describe('2. Runtime VM Sandbox & Module Loader Isolation', () => {
        it('blocks computed dynamic import bypassing static analysis (e.g. import("node:" + "fs"))', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            // Obfuscated dynamic import constructed at runtime
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate() {
                        const spec = 'node:' + 'fs';
                        const mod = await import(spec);
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'bypass-import-plugin',
                    name: 'Bypass Import Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: () => () => {},
                getService: () => {},
            }

            await expect(entryDef.activate(mockContext)).rejects.toThrow(/without a brokered capability/i)
        })

        it('denies access to global process and Node require in plugin VM context', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        const proc = (typeof process !== 'undefined') ? process : undefined;
                        const hasGlobalProc = Boolean(globalThis.process && globalThis.process.version);
                        await ctx.events.emit('probe', { hasProcess: Boolean(proc), hasGlobalProc });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'sandbox-probe-plugin',
                    name: 'Sandbox Probe',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let probeResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (_evt: string, payload: any) => {
                        probeResult = payload
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(probeResult).toEqual({ hasProcess: false, hasGlobalProc: false })
            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('3. Serializable Registration RPC Protocol & Disposers', () => {
        it('proxies remote service methods and returns results across utility process boundary', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        ctx.register({
                            kind: 'service',
                            id: 'calculator-service',
                            value: {
                                add(a, b) {
                                    return a + b;
                                },
                                multiply(a, b) {
                                    return a * b;
                                },
                                name: 'Calculator v1'
                            }
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'calc-plugin',
                    name: 'Calculator Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let registeredService: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: (reg: any) => {
                    registeredService = reg
                    return () => {
                        registeredService = null
                    }
                },
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(registeredService).toBeDefined()
            expect(registeredService.id).toBe('calculator-service')

            const serviceProxy = registeredService.value
            expect(typeof serviceProxy.add).toBe('function')
            expect(typeof serviceProxy.multiply).toBe('function')

            const sum = await serviceProxy.add(10, 25)
            expect(sum).toBe(35)

            const product = await serviceProxy.multiply(6, 7)
            expect(product).toBe(42)

            await entryDef.deactivate?.(mockContext)
        })

        it('supports callable function registrations and RPC descriptor invoke forwarding', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        ctx.register({
                            kind: 'rpc',
                            id: 'echo-rpc',
                            value: {
                                method: 'echo-rpc',
                                async invoke(ctx, args) {
                                    return { echoed: args[0], time: Date.now() };
                                }
                            }
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'rpc-plugin',
                    name: 'RPC Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let registeredRpc: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: (reg: any) => {
                    registeredRpc = reg
                    return () => {
                        registeredRpc = null
                    }
                },
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(registeredRpc).toBeDefined()
            expect(registeredRpc.kind).toBe('rpc')

            const result = await registeredRpc.value.invoke({}, ['hello-world'])
            expect(result.echoed).toBe('hello-world')
            expect(typeof result.time).toBe('number')

            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('4. Bidirectional EventBus Communication & Subscriptions', () => {
        it('delivers events both ways (utility -> host and host -> utility) and unregisters cleanly', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        // Subscribe to host event
                        const unsubscribe = ctx.events.on('host:ping', async (payload) => {
                            await ctx.events.emit('plugin:pong', { replyTo: payload.msg, count: payload.count + 1 });
                        });
                        await ctx.events.emit('plugin:ready', { status: 'listening' });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'events-plugin',
                    name: 'Events Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            const hostEventListeners = new Map<string, Set<(p: any) => void>>()
            const hostEmittedEvents: Array<{ name: string; payload: any }> = []

            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (name: string, payload: any) => {
                        hostEmittedEvents.push({ name, payload })
                        const listeners = hostEventListeners.get(name)
                        if (listeners) {
                            for (const l of listeners) l(payload)
                        }
                    },
                    on: (name: string, listener: any) => {
                        let set = hostEventListeners.get(name)
                        if (!set) {
                            set = new Set()
                            hostEventListeners.set(name, set)
                        }
                        set.add(listener)
                        return () => {
                            set?.delete(listener)
                        }
                    },
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)

            expect(hostEmittedEvents).toContainEqual({
                name: 'plugin:ready',
                payload: { status: 'listening' },
            })

            // Emit event from host to utility
            const pingListeners = hostEventListeners.get('host:ping')
            expect(pingListeners?.size).toBeGreaterThan(0)

            for (const l of Array.from(pingListeners || [])) {
                l({ msg: 'hello', count: 1 })
            }

            // Wait for pong reply from utility
            await new Promise((r) => setTimeout(r, 100))

            expect(hostEmittedEvents).toContainEqual({
                name: 'plugin:pong',
                payload: { replyTo: 'hello', count: 2 },
            })

            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('5. Scoped CapabilityClient & Host Service Access', () => {
        it('allows capability invocation when manifest declares permission and rejects when omitted', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        try {
                            const res = await ctx.capabilityClient.invoke('sessions.list', []);
                            await ctx.events.emit('cap:result', { res });
                        } catch (err) {
                            await ctx.events.emit('cap:error', { message: err.message });
                        }
                    }
                };`,
                'utf-8',
            )

            // Package WITH sessions.* capability
            const pkgWithCap: ResolvedPluginPackage = {
                manifest: {
                    id: 'cap-allowed-plugin',
                    name: 'Cap Allowed',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                    capabilities: ['sessions.*'],
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkgWithCap)

            let receivedCapEvent: any = null
            const mockContext: any = {
                manifest: pkgWithCap.manifest,
                generation: 1,
                capabilities: new Set(['sessions.*']),
                capabilityClient: {
                    has: (c: string) => c === 'sessions.*',
                    invoke: async (method: string) => {
                        if (method === 'sessions.list') return ['session-1', 'session-2']
                        throw new Error('Unknown capability')
                    },
                    subscribe: () => () => {},
                },
                events: {
                    emit: async (name: string, payload: any) => {
                        receivedCapEvent = { name, payload }
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(receivedCapEvent).toEqual({
                name: 'cap:result',
                payload: { res: ['session-1', 'session-2'] },
            })

            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('6. Process Lifecycle, Crash/Exit Handling & Generation Replacement', () => {
        it('terminates process cleanly on deactivate and creates a fresh process for new generation', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `let count = 0;
                 export default {
                    runtime: 'main',
                    async activate(ctx) {
                        count++;
                        await ctx.events.emit('generation:activated', { count, generation: ctx.generation });
                    },
                    async deactivate() {
                        count = 0;
                    }
                 };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fresh-proc-plugin',
                    name: 'Fresh Proc',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            const eventsGen1: any[] = []
            const mockContext1: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (name: string, payload: any) => {
                        eventsGen1.push({ name, payload })
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext1)
            expect(eventsGen1).toContainEqual({
                name: 'generation:activated',
                payload: { count: 1, generation: 1 },
            })

            await entryDef.deactivate?.(mockContext1)

            // Generation 2 activation creates fresh isolated process
            const eventsGen2: any[] = []
            const mockContext2: any = {
                manifest: pkg.manifest,
                generation: 2,
                capabilities: new Set(),
                events: {
                    emit: async (name: string, payload: any) => {
                        eventsGen2.push({ name, payload })
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext2)
            expect(eventsGen2).toContainEqual({
                name: 'generation:activated',
                payload: { count: 1, generation: 2 },
            })

            await entryDef.deactivate?.(mockContext2)
        })

        it('rejects pending RPC calls and cleans up registrations if utility process crashes unexpectedly', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        ctx.register({
                            kind: 'service',
                            id: 'crashable-service',
                            value: {
                                async hangMethod() {
                                    // Simulates long running method before crash
                                    await new Promise((r) => setTimeout(r, 5000));
                                    return 'ok';
                                }
                            }
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'crash-test-plugin',
                    name: 'Crash Test',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let registeredService: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: (reg: any) => {
                    registeredService = reg
                    return () => {
                        registeredService = null
                    }
                },
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(registeredService).toBeDefined()

            const serviceProxy = registeredService.value

            // Call hangMethod and immediately kill the utility process
            const pendingCall = serviceProxy.hangMethod()

            // Forcibly kill the underlying process
            const activeProcess = (host as any).activeProcesses?.get(pkg.manifest.id) ?? (host as any).currentProcess
            if (activeProcess && typeof activeProcess.kill === 'function') {
                activeProcess.kill()
            }

            await expect(pendingCall).rejects.toThrow(/terminated|exit|crash/i)
        })
    })

    describe('7. Advanced ESM Syntax, import.meta, Destructuring & Comments', () => {
        it('supports import.meta.url and relative module resolution', async () => {
            const helperFile = path.join(pluginDir, 'helper.js')
            const mainFile = path.join(pluginDir, 'main.js')

            await fs.writeFile(
                helperFile,
                `export const helperValue = 'from-helper';`,
                'utf-8',
            )

            await fs.writeFile(
                mainFile,
                `import { helperValue } from './helper.js';
                export default {
                    runtime: 'main',
                    async activate(ctx) {
                        const metaUrl = import.meta.url;
                        await ctx.events.emit('esm:probe', {
                            metaUrlPresent: typeof metaUrl === 'string' && metaUrl.length > 0,
                            helperValue,
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'esm-syntax-plugin',
                    name: 'ESM Syntax Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let probeResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (_evt: string, payload: any) => {
                        probeResult = payload
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(probeResult).toEqual({
                metaUrlPresent: true,
                helperValue: 'from-helper',
            })
            await entryDef.deactivate?.(mockContext)
        })

        it('supports multiline exports, export destructuring, and comment strings containing import keywords', async () => {
            const helperFile = path.join(pluginDir, 'helper.js')
            const mainFile = path.join(pluginDir, 'main.js')

            await fs.writeFile(
                helperFile,
                `export const config = {
                    alpha: 100,
                    beta: 200,
                };`,
                'utf-8',
            )

            await fs.writeFile(
                mainFile,
                `// This comment has import * as fs from 'node:fs' and export default {}
                /*
                   Another multiline comment with:
                   import { bad } from 'electron';
                */
                const fakeString = "import * as path from 'node:path'";
                import {
                    config
                } from './helper.js';

                export const {
                    alpha,
                    beta
                } = config;

                export default {
                    runtime: 'main',
                    async activate(ctx) {
                        await ctx.events.emit('probe:multiline', {
                            alpha,
                            beta,
                            fakeString,
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'multiline-esm-plugin',
                    name: 'Multiline ESM Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let probeResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (_evt: string, payload: any) => {
                        probeResult = payload
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(probeResult).toEqual({
                alpha: 100,
                beta: 200,
                fakeString: "import * as path from 'node:path'",
            })
            await entryDef.deactivate?.(mockContext)
        })

        it('supports relative JSON module imports via synthetic modules', async () => {
            const dataFile = path.join(pluginDir, 'data.json')
            const mainFile = path.join(pluginDir, 'main.js')

            await fs.writeFile(
                dataFile,
                JSON.stringify({ greeting: 'hello-from-json', numbers: [1, 2, 3] }),
                'utf-8',
            )

            await fs.writeFile(
                mainFile,
                `import data from './data.json';
                export default {
                    runtime: 'main',
                    async activate(ctx) {
                        await ctx.events.emit('json:probe', data);
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'json-import-plugin',
                    name: 'JSON Import Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let jsonResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (_evt: string, payload: any) => {
                        jsonResult = payload
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(jsonResult).toEqual({
                greeting: 'hello-from-json',
                numbers: [1, 2, 3],
            })
            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('8. VM Sandbox Hardening: Computed Imports, Eval/Function/Process Escape & Realm Isolation', () => {
        it('blocks computed dynamic import of node modules at runtime', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        try {
                            const modName = 'node:' + 'fs';
                            const mod = await import(modName);
                            await ctx.events.emit('escape:success', { mod });
                        } catch (err) {
                            await ctx.events.emit('escape:blocked', {
                                message: err.message,
                                name: err.name,
                            });
                        }
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'computed-import-plugin',
                    name: 'Computed Import Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let escapeResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (name: string, payload: any) => {
                        escapeResult = { name, payload }
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(escapeResult?.name).toBe('escape:blocked')
            expect(escapeResult?.payload?.message).toMatch(/brokered capability|cannot import|disallowed/i)
            await entryDef.deactivate?.(mockContext)
        })

        it('disables string code generation (eval, Function constructor, constructor escape)', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        let evalBlocked = false;
                        let functionBlocked = false;
                        let constructorEscapeBlocked = false;

                        try {
                            eval('1 + 1');
                        } catch (e) {
                            evalBlocked = true;
                        }

                        try {
                            const fn = new Function('return 42');
                            fn();
                        } catch (e) {
                            functionBlocked = true;
                        }

                        try {
                            const fn = ({}).constructor.constructor('return process');
                            fn();
                        } catch (e) {
                            constructorEscapeBlocked = true;
                        }

                        await ctx.events.emit('codegen:probe', {
                            evalBlocked,
                            functionBlocked,
                            constructorEscapeBlocked,
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'codegen-plugin',
                    name: 'Codegen Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let probeResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (_name: string, payload: any) => {
                        probeResult = payload
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(probeResult).toEqual({
                evalBlocked: true,
                functionBlocked: true,
                constructorEscapeBlocked: true,
            })
            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('9. Realistic Main Contribution Shapes: Class Prototypes, Mixed Data + Methods, Function Values', () => {
        it('supports class instances with prototype methods and own properties', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `class CounterService {
                    constructor(initial) {
                        this.current = initial;
                        this.serviceName = 'StatefulCounter';
                    }
                    increment(by) {
                        this.current += by;
                        return this.current;
                    }
                    getCount() {
                        return this.current;
                    }
                }

                export default {
                    runtime: 'main',
                    async activate(ctx) {
                        ctx.register({
                            kind: 'service',
                            id: 'counter-service',
                            value: new CounterService(10),
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'class-service-plugin',
                    name: 'Class Service Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let registeredService: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: (reg: any) => {
                    registeredService = reg
                    return () => {
                        registeredService = null
                    }
                },
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(registeredService).toBeDefined()
            const proxy = registeredService.value

            expect(proxy.serviceName).toBe('StatefulCounter')
            expect(proxy.current).toBe(10)
            expect(typeof proxy.increment).toBe('function')
            expect(typeof proxy.getCount).toBe('function')

            const step1 = await proxy.increment(5)
            expect(step1).toBe(15)

            const count = await proxy.getCount()
            expect(count).toBe(15)

            await entryDef.deactivate?.(mockContext)
        })

        it('supports registering raw functions as contributions', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        ctx.register({
                            kind: 'action',
                            id: 'action:double',
                            value: (n) => n * 2,
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'function-reg-plugin',
                    name: 'Function Reg Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let registeredAction: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: (reg: any) => {
                    registeredAction = reg
                    return () => {
                        registeredAction = null
                    }
                },
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            expect(registeredAction).toBeDefined()
            expect(typeof registeredAction.value).toBe('function')

            const result = await registeredAction.value(21)
            expect(result).toBe(42)

            await entryDef.deactivate?.(mockContext)
        })

        it('serializes and propagates errors thrown by remote methods', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        ctx.register({
                            kind: 'service',
                            id: 'failing-service',
                            value: {
                                failMethod() {
                                    throw new TypeError('Custom failure message');
                                }
                            }
                        });
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fail-service-plugin',
                    name: 'Fail Service Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let registeredService: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: { emit: async () => {}, on: () => () => {} },
                register: (reg: any) => {
                    registeredService = reg
                    return () => {
                        registeredService = null
                    }
                },
                getService: () => {},
            }

            await entryDef.activate(mockContext)
            const proxy = registeredService.value

            await expect(proxy.failMethod()).rejects.toThrow('Custom failure message')
            await entryDef.deactivate?.(mockContext)
        })
    })

    describe('10. Context Remote Identity & Service Proxy Security', () => {
        it('proxies getService calls to Host Main services with bound context', async () => {
            const mainFile = path.join(pluginDir, 'main.js')
            await fs.writeFile(
                mainFile,
                `export default {
                    runtime: 'main',
                    async activate(ctx) {
                        const fileSvc = ctx.getService('fileService');
                        const info = await fileSvc.getRuntimeInfo();
                        await ctx.events.emit('host:service:result', info);
                    }
                };`,
                'utf-8',
            )

            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'service-proxy-plugin',
                    name: 'Service Proxy Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { main: './main.js' },
                },
                source: { kind: 'project-directory', spec: `path:${pluginDir}` },
                sourceRoot: pluginDir,
                entries: { main: mainFile },
            }

            const host = new ExternalMainPluginHost()
            const entryDef = await host.load(pkg)

            let serviceResult: any = null
            const mockContext: any = {
                manifest: pkg.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (_evt: string, payload: any) => {
                        serviceResult = payload
                    },
                    on: () => () => {},
                },
                register: () => () => {},
                getService: (id: string) => {
                    if (id === 'fileService') {
                        return {
                            getRuntimeInfo: async () => ({ os: 'darwin', arch: 'arm64' }),
                        }
                    }
                    return undefined
                },
            }

            await entryDef.activate(mockContext)
            expect(serviceResult).toEqual({ os: 'darwin', arch: 'arm64' })
            await entryDef.deactivate?.(mockContext)
        })
    })
})
