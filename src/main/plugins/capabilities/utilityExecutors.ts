import { utilityProcess } from 'electron'
import { realpathSync } from 'node:fs'
import { relative, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedPluginPackage, UtilityExecutorContribution, UtilityExecutorHandle } from '@cpa/plugin-api'
import type { ContributionRegistry } from '@cpa/plugin-kernel'
import type { MainCapabilityBroker } from './MainCapabilityBroker.js'

export function bindUtilityExecutors(broker: MainCapabilityBroker, registry: ContributionRegistry, getPackage: (id: string) => ResolvedPluginPackage | undefined, bundledRoot: string): () => void {
    const active = new Map<UtilityExecutorHandle, { owner: string; moduleUrl: string }>()
    const disposeRpc = broker.register({
        method: 'runtime.utility.fork', capability: 'process.utility',
        validate(args: unknown[]): asserts args is [string] {
            if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('An executor contribution id is required')
        },
        async invoke(context, id) {
            if (context.runtime !== 'main') throw new Error('Utility executor handles are main-runtime only')
            const contribution = registry.list<UtilityExecutorContribution>('background-job').find((item) => item.owner.id === context.pluginId && item.id === id)
            const pkg = getPackage(context.pluginId)
            if (!contribution || !pkg) throw new Error('Executor is not on the committed plugin whitelist')
            if (pkg.source.kind !== 'bundled') throw new Error('Utility handles require an in-process main plugin')
            const modulePath = realpathSync(fileURLToPath(contribution.value.moduleUrl))
            const roots = [pkg.sourceRoot, ...(pkg.source.kind === 'bundled' ? [join(bundledRoot, pkg.manifest.id)] : [])]
            const allowed = roots.some((root) => {
                try {
                    const path = relative(realpathSync(root), modulePath)
                    return path !== '' && !path.startsWith('..') && !isAbsolute(path)
                } catch { return false }
            })
            if (!allowed || !modulePath.endsWith('.js')) throw new Error('Executor module must be a JavaScript file within its plugin package')
            const child = utilityProcess.fork(modulePath, [], { stdio: 'pipe', serviceName: 'Plugin utility executor' })
            const handle: UtilityExecutorHandle = {
                postMessage: (message) => child.postMessage(message),
                onMessage: (listener) => { child.on('message', listener) },
                onExit: (listener) => { child.on('exit', listener) },
                onStderr: (listener) => { child.stderr?.on('data', (data: Buffer) => listener(String(data))) },
                kill: () => { child.kill() },
            }
            active.set(handle, { owner: contribution.owner.id, moduleUrl: contribution.value.moduleUrl })
            child.on('exit', () => { active.delete(handle) })
            return handle
        },
    })
    const disposeRegistry = registry.subscribe('background-job', () => {
        const current = registry.list<UtilityExecutorContribution>('background-job')
        for (const [handle, record] of active) if (!current.some((item) => item.owner.id === record.owner && item.value.moduleUrl === record.moduleUrl)) handle.kill()
    })
    return () => { disposeRpc(); disposeRegistry(); for (const handle of active.keys()) handle.kill(); active.clear() }
}
