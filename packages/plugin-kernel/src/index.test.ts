import { describe, expect, it } from 'vitest'
import * as kernel from './index.js'

describe('@cpa/plugin-kernel entrypoint', () => {
    it('re-exports plugin-api exports', () => {
        expect(kernel.PluginError).toBeDefined()
    })

    it('re-exports registry, catalog, and dependency resolver', () => {
        expect(kernel.ContributionRegistry).toBeDefined()
        expect(kernel.ActivationTransaction).toBeDefined()
        expect(kernel.ManifestContributionPolicy).toBeDefined()
        expect(kernel.PluginCatalog).toBeDefined()
        expect(kernel.resolvePluginGraph).toBeDefined()
    })

    it('re-exports runtime lifecycle, lease manager, event bus, and safety boundary', () => {
        expect(kernel.PluginRuntime).toBeDefined()
        expect(kernel.DenyByDefaultCapabilityClient).toBeDefined()
        expect(kernel.GenerationLeaseManager).toBeDefined()
        expect(kernel.PluginEventBus).toBeDefined()
        expect(kernel.safeInvoke).toBeDefined()
    })
})
