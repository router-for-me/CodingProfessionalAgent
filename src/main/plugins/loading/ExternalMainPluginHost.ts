import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
    PluginCapabilityError,
    PluginError,
    type PluginContext,
    type PluginEntryDefinition,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { assertPathInsideSourceRoot } from '../sources/sourceRootGuard.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const NODE_BUILTINS = new Set<string>([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
    'node:test',
    'node:sqlite',
])

const ALLOWED_BARE_IMPORTS = new Set<string>([
    '@cpa/plugin-api',
    '@cpa/plugin-sdk',
])

export interface IUtilityProcess {
    postMessage(message: unknown): void
    on(event: 'message', listener: (message: any) => void): this
    on(event: 'exit', listener: (code: number) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    kill(): boolean
    pid?: number
}

export interface UtilityProcessForkOptions {
    serviceName?: string
    env?: Record<string, string>
    cwd?: string
}

export type UtilityProcessFactory = (
    modulePath: string,
    args?: string[],
    options?: UtilityProcessForkOptions,
) => IUtilityProcess

export function createDefaultUtilityProcessFactory(): UtilityProcessFactory {
    return (modulePath: string, args: string[] = [], options: UtilityProcessForkOptions = {}) => {
        // Try Electron utilityProcess if running under Electron
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const electron = require('electron')
            if (electron?.utilityProcess?.fork) {
                const child = electron.utilityProcess.fork(modulePath, args, {
                    serviceName: options.serviceName ?? 'cpa-plugin-utility',
                    env: options.env,
                    cwd: options.cwd,
                    execArgv: ['--experimental-vm-modules'],
                })
                const adapter: IUtilityProcess = {
                    postMessage: (msg: unknown) => child.postMessage(msg),
                    on: (event: string, listener: any) => {
                        child.on(event, listener)
                        return adapter
                    },
                    kill: () => child.kill(),
                    pid: child.pid,
                }
                return adapter
            }
        } catch {
            // Non-electron environment (e.g. Node tests)
        }

        // Node.js child_process fallback for tests
        const child = childProcess.fork(modulePath, args, {
            env: { ...process.env, ...options.env },
            cwd: options.cwd,
            execArgv: ['--experimental-vm-modules'],
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        })

        const adapter: IUtilityProcess = {
            postMessage: (msg: unknown) => {
                if (child.connected && !child.killed) {
                    child.send(msg as childProcess.Serializable)
                }
            },
            on: (event: string, listener: any) => {
                child.on(event, listener)
                return adapter
            },
            kill: () => {
                return child.kill('SIGTERM')
            },
            pid: child.pid,
        }
        return adapter
    }
}

/**
 * Extracts import/require/export specifiers from source code.
 */
export function extractImportSpecifiers(code: string): string[] {
    const specifiers: string[] = []

    // 1. Remove comments
    const noComments = code.replace(
        /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g,
        (match, str) => (str ? str : ' '),
    )

    // 2. Match ESM static import / export statements:
    // import ... from '...' or import '...'
    // export ... from '...'
    const staticImportRegex = /(?:^|[;\n\r])\s*(?:import\s+(?:(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"])|export\s+(?:[\w*\s{},*]+\s+from\s+['"]([^'"]+)['"]))/g
    let match: RegExpExecArray | null
    while ((match = staticImportRegex.exec(noComments)) !== null) {
        const spec = match[1] || match[2]
        if (spec) specifiers.push(spec)
    }

    // 3. Match dynamic import('...') and require('...')
    const dynamicImportRegex = /(?:^|[^\w$.])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    while ((match = dynamicImportRegex.exec(noComments)) !== null) {
        if (match[1]) specifiers.push(match[1])
    }

    return specifiers
}

/**
 * Validates that an external plugin package does not import unauthorized modules,
 * node built-ins without capabilities, or relative paths escaping the source root.
 */
export async function validateExternalPluginImports(
    pluginPackage: ResolvedPluginPackage,
): Promise<void> {
    const entryPath = pluginPackage.entries.main
    if (!entryPath) {
        return
    }

    const realSourceRoot = await fs.realpath(pluginPackage.sourceRoot).catch(() => pluginPackage.sourceRoot)
    const visited = new Set<string>()
    const queue = [entryPath]

    while (queue.length > 0) {
        const currentPath = queue.shift()!
        const realCurrentPath = await fs.realpath(currentPath).catch(() => currentPath)

        if (visited.has(realCurrentPath)) {
            continue
        }
        visited.add(realCurrentPath)

        let content: string
        try {
            content = await fs.readFile(realCurrentPath, 'utf-8')
        } catch {
            continue
        }

        const specifiers = extractImportSpecifiers(content)
        for (const specifier of specifiers) {
            // Check Node built-ins or node: prefix
            if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) {
                throw new PluginCapabilityError(
                    `External plugin cannot import ${specifier} without a brokered capability`,
                    { pluginId: pluginPackage.manifest.id },
                )
            }

            // Check Electron imports
            if (specifier === 'electron' || specifier.startsWith('electron/')) {
                throw new PluginCapabilityError(
                    `External plugin cannot import ${specifier} without a brokered capability`,
                    { pluginId: pluginPackage.manifest.id },
                )
            }

            // Check bare package imports
            const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
            if (!isRelative) {
                if (!ALLOWED_BARE_IMPORTS.has(specifier)) {
                    throw new PluginCapabilityError(
                        `External plugin cannot import ${specifier} without a brokered capability`,
                        { pluginId: pluginPackage.manifest.id },
                    )
                }
                continue
            }

            // Relative import check
            const targetCandidate = path.resolve(path.dirname(realCurrentPath), specifier)
            let resolvedTarget = targetCandidate

            // Check file extensions if candidate doesn't exist directly
            try {
                await fs.stat(resolvedTarget)
            } catch {
                for (const ext of ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs']) {
                    const withExt = `${targetCandidate}${ext}`
                    try {
                        const st = await fs.stat(withExt)
                        if (st.isFile()) {
                            resolvedTarget = withExt
                            break
                        }
                    } catch {
                        // Keep checking
                    }
                }
            }

            // Must strictly stay inside sourceRoot
            await assertPathInsideSourceRoot(resolvedTarget, realSourceRoot)

            if (!visited.has(resolvedTarget)) {
                queue.push(resolvedTarget)
            }
        }
    }
}

export interface ExternalMainPluginHostOptions {
    bootstrapPath?: string
    utilityProcessFactory?: UtilityProcessFactory
}

/**
 * Host for executing external main plugins in an isolated Electron utility process.
 */
export class ExternalMainPluginHost {
    private readonly bootstrapPath: string
    private readonly utilityProcessFactory: UtilityProcessFactory
    readonly activeProcesses = new Map<string, IUtilityProcess>()

    constructor(options?: ExternalMainPluginHostOptions | string) {
        if (typeof options === 'string') {
            this.bootstrapPath = options
            this.utilityProcessFactory = createDefaultUtilityProcessFactory()
        } else {
            this.bootstrapPath = options?.bootstrapPath ?? path.join(__dirname, 'externalMainBootstrap.mjs')
            this.utilityProcessFactory = options?.utilityProcessFactory ?? createDefaultUtilityProcessFactory()
        }
    }

    private invokeRemoteRpc(
        child: IUtilityProcess,
        registrationId: string,
        method: string | null | undefined,
        args: unknown[],
        pendingRpcs: Map<string, { resolve: (v: any) => void; reject: (err: any) => void }>,
        timeoutMs = 15000,
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const rpcId = `rpc_${randomUUID()}`
            const timer = setTimeout(() => {
                pendingRpcs.delete(rpcId)
                reject(
                    new Error(
                        `RPC timeout invoking remote method "${method ?? 'default'}" on registration "${registrationId}"`,
                    ),
                )
            }, timeoutMs)

            pendingRpcs.set(rpcId, {
                resolve: (val) => {
                    clearTimeout(timer)
                    resolve(val)
                },
                reject: (err) => {
                    clearTimeout(timer)
                    reject(err)
                },
            })

            child.postMessage({
                type: 'rpc:invoke',
                rpcId,
                registrationId,
                method,
                args,
            })
        })
    }

    /**
     * Load an external plugin by validating its imports and initializing an isolated utility process.
     */
    async load(pluginPackage: ResolvedPluginPackage): Promise<PluginEntryDefinition> {
        const entryPath = pluginPackage.entries.main
        if (!entryPath) {
            throw new PluginError(
                `External plugin '${pluginPackage.manifest.id}' has no main entry point declared`,
                { pluginId: pluginPackage.manifest.id },
            )
        }

        // Validate imports and source root boundaries first
        await validateExternalPluginImports(pluginPackage)

        let childProc: IUtilityProcess | null = null
        const pendingRpcs = new Map<string, { resolve: (v: any) => void; reject: (err: any) => void }>()
        const unregisterMap = new Map<string, () => void>()
        const eventSubscribers = new Map<string, () => void>()

        const definition: PluginEntryDefinition = {
            runtime: 'main',
            activate: async (context: PluginContext) => {
                return new Promise<void>((resolve, reject) => {
                    try {
                        let isResolved = false

                        childProc = this.utilityProcessFactory(this.bootstrapPath, [], {
                            serviceName: `cpa-plugin-${pluginPackage.manifest.id}`,
                            cwd: pluginPackage.sourceRoot,
                        })

                        this.activeProcesses.set(pluginPackage.manifest.id, childProc)

                        const cleanupAll = (code?: number) => {
                            this.activeProcesses.delete(pluginPackage.manifest.id)
                            for (const unreg of unregisterMap.values()) {
                                try {
                                    unreg()
                                } catch {
                                    // Ignore disposer errors
                                }
                            }
                            unregisterMap.clear()

                            for (const unsub of eventSubscribers.values()) {
                                try {
                                    unsub()
                                } catch {
                                    // Ignore disposer errors
                                }
                            }
                            eventSubscribers.clear()

                            const err = new Error(
                                `Utility process terminated ${code !== undefined ? `with exit code ${code}` : ''}`,
                            )
                            for (const pending of pendingRpcs.values()) {
                                pending.reject(err)
                            }
                            pendingRpcs.clear()

                            if (!isResolved) {
                                isResolved = true
                                reject(err)
                            }
                        }

                        childProc.on('message', async (msg: any) => {
                            try {
                                if (msg.type === 'initialized') {
                                    childProc?.postMessage({
                                        type: 'activate',
                                        manifest: pluginPackage.manifest,
                                        generation: context.generation,
                                        capabilities: Array.from(context.capabilities),
                                    })
                                } else if (msg.type === 'activated') {
                                    if (!isResolved) {
                                        isResolved = true
                                        resolve()
                                    }
                                } else if (msg.type === 'error') {
                                    const err = new Error(msg.error)
                                    if (msg.errorName === 'PluginCapabilityError') {
                                        err.name = 'PluginCapabilityError'
                                    }
                                    if (!isResolved) {
                                        isResolved = true
                                        reject(err)
                                    }
                                } else if (msg.type === 'event:emit') {
                                    void context.events.emit(msg.eventName, msg.payload)
                                } else if (msg.type === 'event:subscribe') {
                                    if (!eventSubscribers.has(msg.eventName)) {
                                        const unsub = context.events.on(msg.eventName, (payload) => {
                                            childProc?.postMessage({
                                                type: 'event:delivery',
                                                eventName: msg.eventName,
                                                payload,
                                            })
                                        })
                                        eventSubscribers.set(msg.eventName, unsub)
                                    }
                                } else if (msg.type === 'event:unsubscribe') {
                                    const unsub = eventSubscribers.get(msg.eventName)
                                    if (unsub) {
                                        unsub()
                                        eventSubscribers.delete(msg.eventName)
                                    }
                                } else if (msg.type === 'register') {
                                    let proxyValue: any
                                    const desc = msg.descriptor || {}

                                    if (desc.isFunction) {
                                        proxyValue = (...args: any[]) =>
                                            this.invokeRemoteRpc(childProc!, msg.registrationId, null, args, pendingRpcs)
                                    } else if (desc.methodNames && desc.methodNames.length > 0) {
                                        proxyValue = {}
                                        for (const name of desc.methodNames) {
                                            proxyValue[name] = (...args: any[]) =>
                                                this.invokeRemoteRpc(childProc!, msg.registrationId, name, args, pendingRpcs)
                                        }
                                        if (desc.staticValue) {
                                            Object.assign(proxyValue, desc.staticValue)
                                        }
                                    } else if (msg.kind === 'rpc') {
                                        proxyValue = {
                                            method: msg.id,
                                            invoke: async (ctx: any, args: any[]) => {
                                                return this.invokeRemoteRpc(
                                                    childProc!,
                                                    msg.registrationId,
                                                    'invoke',
                                                    [ctx, args],
                                                    pendingRpcs,
                                                )
                                            },
                                        }
                                    } else if (desc.staticValue !== undefined) {
                                        proxyValue = desc.staticValue
                                    } else {
                                        proxyValue = { plugin: pluginPackage.manifest.id, runtime: 'main' }
                                    }

                                    const unreg = context.register({
                                        kind: msg.kind,
                                        id: msg.id,
                                        target: msg.target,
                                        priority: msg.priority,
                                        value: proxyValue,
                                    })
                                    unregisterMap.set(msg.registrationId, unreg)
                                } else if (msg.type === 'unregister') {
                                    const unreg = unregisterMap.get(msg.registrationId)
                                    if (unreg) {
                                        unreg()
                                        unregisterMap.delete(msg.registrationId)
                                    }
                                } else if (msg.type === 'rpc:result') {
                                    const pending = pendingRpcs.get(msg.rpcId)
                                    if (pending) {
                                        pendingRpcs.delete(msg.rpcId)
                                        pending.resolve(msg.result)
                                    }
                                } else if (msg.type === 'rpc:error') {
                                    const pending = pendingRpcs.get(msg.rpcId)
                                    if (pending) {
                                        pendingRpcs.delete(msg.rpcId)
                                        const err = new Error(msg.error?.message ?? String(msg.error))
                                        if (msg.error?.name) err.name = msg.error.name
                                        pending.reject(err)
                                    }
                                } else if (msg.type === 'capability:invoke') {
                                    try {
                                        if (!context.capabilityClient) {
                                            throw new PluginCapabilityError(
                                                `Capability client not available for plugin '${pluginPackage.manifest.id}'`,
                                            )
                                        }
                                        const result = await context.capabilityClient.invoke(
                                            msg.method,
                                            msg.args ?? [],
                                        )
                                        childProc?.postMessage({
                                            type: 'capability:result',
                                            rpcId: msg.rpcId,
                                            result,
                                        })
                                    } catch (err: any) {
                                        childProc?.postMessage({
                                            type: 'capability:error',
                                            rpcId: msg.rpcId,
                                            error: {
                                                message: err?.message ?? String(err),
                                                name: err?.name ?? 'PluginCapabilityError',
                                            },
                                        })
                                    }
                                } else if (msg.type === 'service:get') {
                                    try {
                                        const service = context.getService(msg.serviceId) as any
                                        if (!service) {
                                            throw new Error(`Service '${msg.serviceId}' not found`)
                                        }
                                        let result: any
                                        if (msg.method) {
                                            if (typeof service[msg.method] !== 'function') {
                                                throw new Error(
                                                    `Method '${msg.method}' not found on service '${msg.serviceId}'`,
                                                )
                                            }
                                            result = await service[msg.method](...(msg.args ?? []))
                                        } else {
                                            result = service
                                        }
                                        childProc?.postMessage({
                                            type: 'capability:result',
                                            rpcId: msg.rpcId,
                                            result,
                                        })
                                    } catch (err: any) {
                                        childProc?.postMessage({
                                            type: 'capability:error',
                                            rpcId: msg.rpcId,
                                            error: {
                                                message: err?.message ?? String(err),
                                                name: err?.name ?? 'Error',
                                            },
                                        })
                                    }
                                }
                            } catch (err: any) {
                                if (!isResolved) {
                                    isResolved = true
                                    reject(err)
                                }
                            }
                        })

                        childProc.on('error', (err) => {
                            cleanupAll()
                        })

                        childProc.on('exit', (code) => {
                            cleanupAll(code)
                        })

                        childProc.postMessage({
                            type: 'init',
                            entryPath,
                            manifest: pluginPackage.manifest,
                            sourceRoot: pluginPackage.sourceRoot,
                            generation: context.generation,
                            capabilities: Array.from(context.capabilities),
                        })
                    } catch (err) {
                        reject(err)
                    }
                })
            },
            deactivate: async () => {
                if (childProc) {
                    await new Promise<void>((resolve) => {
                        const timeout = setTimeout(() => {
                            void childProc?.kill()
                            this.activeProcesses.delete(pluginPackage.manifest.id)
                            childProc = null
                            resolve()
                        }, 1000)

                        childProc?.on('message', (msg: any) => {
                            if (msg.type === 'deactivated') {
                                clearTimeout(timeout)
                                void childProc?.kill()
                                this.activeProcesses.delete(pluginPackage.manifest.id)
                                childProc = null
                                resolve()
                            }
                        })

                        childProc?.postMessage({ type: 'deactivate' })
                    })
                }
            },
        }

        return definition
    }
}
