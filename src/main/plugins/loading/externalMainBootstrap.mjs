/**
 * External Main Plugin Bootstrap Host
 * Runs external main plugin entries in an isolated Electron utility process with a sandboxed VM.
 */
import * as vm from 'node:vm'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'
import { randomUUID } from 'node:crypto'
import * as pluginApi from '@cpa/plugin-api'
import * as pluginSdk from '@cpa/plugin-sdk'
import {
    PluginCapabilityError,
    PluginError,
    PluginValidationError,
} from '@cpa/plugin-api'

const NODE_BUILTINS = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
    'node:test',
    'node:sqlite',
])

const parentPort = process.parentPort ?? {
    on(event, handler) {
        if (event === 'message') {
            process.on('message', (msg) => handler({ data: msg }))
        }
    },
    postMessage(data) {
        if (typeof process.send === 'function') {
            process.send(data)
        }
    },
}

let activePlugin = null
let currentContext = null
let nextRegId = 1
const localRegistrations = new Map()
const eventListeners = new Map()
const pendingCapRpcs = new Map()

function createSyntheticExportsModule(exportObject, context, identifier) {
    const exportKeys = Object.keys(exportObject)
    return new vm.SyntheticModule(
        exportKeys,
        function () {
            for (const key of exportKeys) {
                this.setExport(key, exportObject[key])
            }
        },
        { context, identifier },
    )
}

function createSandboxContext(manifest) {
    const sandbox = {
        console: Object.freeze({
            log: (...args) => console.log(`[Plugin:${manifest.id}]`, ...args),
            info: (...args) => console.info(`[Plugin:${manifest.id}]`, ...args),
            warn: (...args) => console.warn(`[Plugin:${manifest.id}]`, ...args),
            error: (...args) => console.error(`[Plugin:${manifest.id}]`, ...args),
            debug: (...args) => console.debug(`[Plugin:${manifest.id}]`, ...args),
        }),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        structuredClone,
        process: undefined,
        require: undefined,
        Buffer: undefined,
    }

    return vm.createContext(sandbox, {
        codeGeneration: {
            strings: false,
            wasm: false,
        },
    })
}

async function loadSandboxedModuleGraph(entryPath, sourceRoot, manifest) {
    const context = createSandboxContext(manifest)
    const moduleCache = new Map()

    const apiModule = createSyntheticExportsModule(pluginApi, context, '@cpa/plugin-api')
    const sdkModule = createSyntheticExportsModule(pluginSdk, context, '@cpa/plugin-sdk')
    moduleCache.set('@cpa/plugin-api', apiModule)
    moduleCache.set('@cpa/plugin-sdk', sdkModule)

    const realSourceRoot = fs.existsSync(sourceRoot) ? fs.realpathSync(sourceRoot) : path.resolve(sourceRoot)

    async function resolveModule(specifier, referrerPath) {
        if (specifier === '@cpa/plugin-api') return apiModule
        if (specifier === '@cpa/plugin-sdk') return sdkModule

        if (
            specifier.startsWith('node:') ||
            NODE_BUILTINS.has(specifier) ||
            specifier === 'electron' ||
            specifier.startsWith('electron/')
        ) {
            throw new PluginCapabilityError(
                `External plugin cannot import ${specifier} without a brokered capability`,
                { pluginId: manifest.id },
            )
        }

        if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/') && !path.isAbsolute(specifier)) {
            throw new PluginCapabilityError(
                `External plugin cannot import ${specifier} without a brokered capability`,
                { pluginId: manifest.id },
            )
        }

        const candidate = path.isAbsolute(specifier) ? specifier : path.resolve(path.dirname(referrerPath), specifier)
        let targetPath = candidate

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
            for (const ext of ['.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs']) {
                const withExt = `${candidate}${ext}`
                if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
                    targetPath = withExt
                    break
                }
            }
        }

        if (!fs.existsSync(targetPath)) {
            throw new Error(`Cannot find module '${specifier}' from '${referrerPath}'`)
        }

        const realTarget = fs.realpathSync(targetPath)
        const rel = path.relative(realSourceRoot, realTarget)
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
            throw new PluginValidationError(
                `Plugin resource escapes source root: '${specifier}'`,
                [`Path escape: ${specifier}`],
                { pluginId: manifest.id },
            )
        }

        if (moduleCache.has(realTarget)) {
            return moduleCache.get(realTarget)
        }

        let mod
        if (realTarget.endsWith('.json')) {
            const rawJson = fs.readFileSync(realTarget, 'utf-8')
            const parsed = JSON.parse(rawJson)
            mod = new vm.SyntheticModule(
                ['default'],
                function () {
                    this.setExport('default', parsed)
                },
                { context, identifier: realTarget },
            )
        } else {
            const code = fs.readFileSync(realTarget, 'utf-8')
            mod = new vm.SourceTextModule(code, {
                context,
                identifier: realTarget,
                initializeImportMeta(meta) {
                    meta.url = pathToFileURL(realTarget).href
                },
                importModuleDynamically: async (dynSpecifier, script) => {
                    const referrer = script?.identifier ?? realTarget
                    const dynamicMod = await resolveModule(dynSpecifier, referrer)
                    if (dynamicMod.status === 'unlinked') {
                        await dynamicMod.link((subSpec) => resolveModule(subSpec, dynamicMod.identifier ?? realTarget))
                    }
                    if (dynamicMod.status !== 'evaluated') {
                        await dynamicMod.evaluate()
                    }
                    return dynamicMod
                },
            })
        }

        moduleCache.set(realTarget, mod)
        return mod
    }

    async function linker(specifier, referencingModule) {
        const referrer = referencingModule?.identifier ?? entryPath
        return resolveModule(specifier, referrer)
    }

    const realEntryPath = fs.realpathSync(entryPath)
    const entryMod = await resolveModule(realEntryPath, realEntryPath)

    if (entryMod.status === 'unlinked') {
        await entryMod.link(linker)
    }
    if (entryMod.status !== 'evaluated') {
        await entryMod.evaluate()
    }

    return entryMod.namespace
}

function extractRegistrationDescriptor(value) {
    const isFunction = typeof value === 'function'
    const methodNames = new Set()
    let staticValue = undefined

    if (value && (typeof value === 'object' || typeof value === 'function')) {
        let current = value
        while (current && current !== Object.prototype && current !== Function.prototype) {
            const propNames = Object.getOwnPropertyNames(current)
            for (const name of propNames) {
                if (
                    name !== 'constructor' &&
                    name !== 'caller' &&
                    name !== 'callee' &&
                    name !== 'arguments' &&
                    name !== 'prototype' &&
                    !name.startsWith('__')
                ) {
                    try {
                        if (typeof value[name] === 'function') {
                            methodNames.add(name)
                        }
                    } catch {
                        // Ignore property access error on restricted properties
                    }
                }
            }
            current = Object.getPrototypeOf(current)
        }

        if (typeof value === 'object' && value !== null) {
            const data = {}
            let hasData = false
            for (const [key, val] of Object.entries(value)) {
                if (typeof val !== 'function') {
                    data[key] = val
                    hasData = true
                }
            }
            if (hasData) {
                try {
                    staticValue = structuredClone(data)
                } catch {
                    staticValue = undefined
                }
            }
        }
    }

    return {
        isFunction,
        methodNames: Array.from(methodNames),
        staticValue,
    }
}

if (parentPort) {
    parentPort.on('message', async (event) => {
        const message = event.data ?? event
        try {
            if (message.type === 'init') {
                const { entryPath, manifest, sourceRoot } = message
                const modNamespace = await loadSandboxedModuleGraph(
                    entryPath,
                    sourceRoot || path.dirname(entryPath),
                    manifest,
                )

                activePlugin = modNamespace.default ?? modNamespace.definition ?? modNamespace
                if (!activePlugin || typeof activePlugin.activate !== 'function') {
                    throw new Error(
                        `Plugin entry '${entryPath}' does not export a valid entry with an activate function`,
                    )
                }
                parentPort.postMessage({ type: 'initialized', ok: true })
            } else if (message.type === 'activate') {
                const capabilities = message.capabilities || []
                currentContext = {
                    manifest: message.manifest,
                    generation: message.generation || 1,
                    capabilities: new Set(capabilities),
                    events: {
                        emit: async (eventName, payload) => {
                            parentPort.postMessage({
                                type: 'event:emit',
                                eventName,
                                payload,
                            })
                        },
                        on: (eventName, listener) => {
                            let listeners = eventListeners.get(eventName)
                            const isFirst = !listeners || listeners.size === 0
                            if (!listeners) {
                                listeners = new Set()
                                eventListeners.set(eventName, listeners)
                            }
                            listeners.add(listener)

                            if (isFirst) {
                                parentPort.postMessage({
                                    type: 'event:subscribe',
                                    eventName,
                                })
                            }

                            return () => {
                                const set = eventListeners.get(eventName)
                                if (set) {
                                    set.delete(listener)
                                    if (set.size === 0) {
                                        eventListeners.delete(eventName)
                                        parentPort.postMessage({
                                            type: 'event:unsubscribe',
                                            eventName,
                                        })
                                    }
                                }
                            }
                        },
                    },
                    register: (reg) => {
                        const regId = `reg_${nextRegId++}`
                        localRegistrations.set(regId, reg.value)

                        const descriptor = extractRegistrationDescriptor(reg.value)

                        parentPort.postMessage({
                            type: 'register',
                            registrationId: regId,
                            kind: reg.kind,
                            id: reg.id,
                            target: reg.target,
                            priority: reg.priority,
                            descriptor,
                        })

                        return () => {
                            localRegistrations.delete(regId)
                            parentPort.postMessage({
                                type: 'unregister',
                                registrationId: regId,
                            })
                        }
                    },
                    capabilityClient: {
                        has: (cap) => capabilities.includes(cap),
                        invoke: async (method, args = []) => {
                            const rpcId = `cap_${randomUUID()}`
                            return new Promise((resolve, reject) => {
                                pendingCapRpcs.set(rpcId, { resolve, reject })
                                parentPort.postMessage({
                                    type: 'capability:invoke',
                                    rpcId,
                                    method,
                                    args,
                                })
                            })
                        },
                        subscribe: (eventName, listener) => {
                            return currentContext.events.on(eventName, listener)
                        },
                    },
                    getService: (serviceId) => {
                        const sid = typeof serviceId === 'string' ? serviceId : serviceId?.id
                        return new Proxy(
                            {},
                            {
                                get(_target, prop) {
                                    if (typeof prop !== 'string') return undefined
                                    return async (...args) => {
                                        const rpcId = `srv_${randomUUID()}`
                                        return new Promise((resolve, reject) => {
                                            pendingCapRpcs.set(rpcId, { resolve, reject })
                                            parentPort.postMessage({
                                                type: 'service:get',
                                                rpcId,
                                                serviceId: sid,
                                                method: prop,
                                                args,
                                            })
                                        })
                                    }
                                },
                            },
                        )
                    },
                }

                if (activePlugin && typeof activePlugin.activate === 'function') {
                    await activePlugin.activate(currentContext)
                }
                parentPort.postMessage({ type: 'activated', ok: true })
            } else if (message.type === 'deactivate') {
                if (activePlugin && typeof activePlugin.deactivate === 'function') {
                    await activePlugin.deactivate(currentContext)
                }
                parentPort.postMessage({ type: 'deactivated', ok: true })
            } else if (message.type === 'rpc:invoke') {
                const { rpcId, registrationId, method, args } = message
                const target = localRegistrations.get(registrationId)
                if (!target) {
                    parentPort.postMessage({
                        type: 'rpc:error',
                        rpcId,
                        error: {
                            message: `Registration '${registrationId}' not found in utility process`,
                        },
                    })
                    return
                }

                try {
                    let result
                    if (typeof target === 'function' && (!method || method === 'invoke' && typeof target.invoke !== 'function')) {
                        result = await target(...(args || []))
                    } else if (method && typeof target[method] === 'function') {
                        result = await target[method](...(args || []))
                    } else if (method === 'invoke' && typeof target.invoke === 'function') {
                        result = await target.invoke(args?.[0], args?.[1])
                    } else {
                        result = target[method] !== undefined ? target[method] : target
                    }

                    parentPort.postMessage({
                        type: 'rpc:result',
                        rpcId,
                        result,
                    })
                } catch (err) {
                    parentPort.postMessage({
                        type: 'rpc:error',
                        rpcId,
                        error: {
                            message: err instanceof Error ? err.message : String(err),
                            name: err instanceof Error ? err.name : 'Error',
                        },
                    })
                }
            } else if (message.type === 'event:delivery') {
                const { eventName, payload } = message
                const listeners = eventListeners.get(eventName)
                if (listeners) {
                    for (const listener of Array.from(listeners)) {
                        try {
                            void listener(payload)
                        } catch (err) {
                            console.error(`[Plugin Event Error]`, err)
                        }
                    }
                }
            } else if (message.type === 'capability:result') {
                const pending = pendingCapRpcs.get(message.rpcId)
                if (pending) {
                    pendingCapRpcs.delete(message.rpcId)
                    pending.resolve(message.result)
                }
            } else if (message.type === 'capability:error') {
                const pending = pendingCapRpcs.get(message.rpcId)
                if (pending) {
                    pendingCapRpcs.delete(message.rpcId)
                    const err = new Error(message.error?.message ?? String(message.error))
                    if (message.error?.name) err.name = message.error.name
                    pending.reject(err)
                }
            }
        } catch (err) {
            parentPort.postMessage({
                type: 'error',
                error: err instanceof Error ? err.message : String(err),
                errorName: err instanceof Error ? err.name : 'Error',
            })
        }
    })
}
