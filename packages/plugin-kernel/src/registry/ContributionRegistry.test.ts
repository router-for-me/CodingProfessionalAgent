import { describe, expect, it, vi } from 'vitest'
import {
    PluginConflictError,
    type ContributionKind,
} from '@cpa/plugin-api'
import {
    ContributionRegistry,
    SINGLE_VALUE_CONTRIBUTION_KINDS,
    isSingleValueContributionKind,
} from './ContributionRegistry.js'

describe('ContributionRegistry & ActivationTransaction', () => {
    it('does not let an old disposer delete a newer contribution', async () => {
        const registry = new ContributionRegistry()
        const first = registry.beginActivation({ id: 'a', version: '1.0.0' })
        first.register('action', 'open', { title: 'A' })
        const disposeA = first.commit()[0]

        const second = registry.beginActivation({ id: 'b', version: '1.0.0' })
        expect(() => second.register('action', 'open', { title: 'B' })).toThrow(
            'Contribution conflict: action/open is owned by a',
        )
        disposeA()
        expect(registry.get('action', 'open')).toBeUndefined()

        // Re-registering after disposal works
        const third = registry.beginActivation({ id: 'c', version: '1.0.0' })
        third.register('action', 'open', { title: 'C' })
        third.commit()
        expect(registry.get('action', 'open')).toEqual({ title: 'C' })

        // Old disposer from 'a' does not delete 'c'
        disposeA()
        expect(registry.get('action', 'open')).toEqual({ title: 'C' })
    })

    it('keeps staged values invisible until commit', () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'a', version: '1.0.0' })
        tx.register('slot', 'turn-header', { componentId: 'turn-header' }, { target: 'chat.header', priority: 10 })
        expect(registry.list('slot', 'chat.header')).toEqual([])
        tx.commit()
        expect(registry.list('slot', 'chat.header')).toHaveLength(1)
    })

    it('supports chainable registration in transaction', () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'plugin-chain', version: '1.0.0' })
        const returnedTx = tx
            .register('action', 'act1', { title: 'Action 1' })
            .register('action', 'act2', { title: 'Action 2' })
        expect(returnedTx).toBe(tx)
        const disposers = tx.commit()
        expect(disposers).toHaveLength(2)
        expect(registry.get('action', 'act1')).toEqual({ title: 'Action 1' })
        expect(registry.get('action', 'act2')).toEqual({ title: 'Action 2' })
    })

    it('rolls back staged contributions and does not notify subscribers', () => {
        const registry = new ContributionRegistry()
        const listener = vi.fn()
        registry.subscribe('slot', listener)

        const tx = registry.beginActivation({ id: 'plugin-a', version: '1.0.0' })
        tx.register('slot', 'header-slot', { component: 'header' }, { target: 'app.header' })
        tx.rollback()

        expect(registry.list('slot', 'app.header')).toEqual([])
        expect(listener).not.toHaveBeenCalled()

        // Attempting to commit after rollback throws
        expect(() => tx.commit()).toThrow()
    })

    it('rejects duplicate single-value registration in same transaction with PluginConflictError', () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'my-plugin', version: '1.0.0' })
        tx.register('service', 'my-service', { foo: 'bar' })
        expect(() => tx.register('service', 'my-service', { foo: 'baz' })).toThrow(PluginConflictError)
        expect(() => tx.register('service', 'my-service', { foo: 'baz' })).toThrow(
            'Contribution conflict: service/my-service is owned by my-plugin',
        )
    })

    it('rejects duplicate single-value registration across different plugins with PluginConflictError', () => {
        const registry = new ContributionRegistry()
        const tx1 = registry.beginActivation({ id: 'plugin-1', version: '1.0.0' })
        tx1.register('view', 'dashboard', { viewName: 'Dashboard' })
        tx1.commit()

        const tx2 = registry.beginActivation({ id: 'plugin-2', version: '1.0.0' })
        expect(() => tx2.register('view', 'dashboard', { viewName: 'AltDashboard' })).toThrow(PluginConflictError)
        expect(() => tx2.register('view', 'dashboard', { viewName: 'AltDashboard' })).toThrow(
            'Contribution conflict: view/dashboard is owned by plugin-1',
        )
    })

    it('rejects conflicting commit if single-value contribution was registered concurrently', () => {
        const registry = new ContributionRegistry()
        const tx1 = registry.beginActivation({ id: 'plugin-1', version: '1.0.0' })
        const tx2 = registry.beginActivation({ id: 'plugin-2', version: '1.0.0' })

        tx1.register('panel', 'review', { title: 'Review 1' })
        // Staging in tx2 is fine if tx1 is not yet committed
        tx2.register('panel', 'review', { title: 'Review 2' })

        tx1.commit()
        // Committing tx2 fails because 'panel/review' is now committed by plugin-1
        expect(() => tx2.commit()).toThrow(
            'Contribution conflict: panel/review is owned by plugin-1',
        )
    })

    it('allows multiple plugins to register multi-value contributions with same contributionId', () => {
        const registry = new ContributionRegistry()
        const tx1 = registry.beginActivation({ id: 'plugin-1', version: '1.0.0' })
        tx1.register('slot', 'banner', { text: 'Plugin 1 banner' }, { target: 'main.banner', priority: 20 })
        tx1.commit()

        const tx2 = registry.beginActivation({ id: 'plugin-2', version: '1.0.0' })
        tx2.register('slot', 'banner', { text: 'Plugin 2 banner' }, { target: 'main.banner', priority: 10 })
        tx2.commit()

        const slots = registry.list('slot', 'main.banner')
        expect(slots).toHaveLength(2)
        // Sorted by priority: plugin-2 (priority 10) before plugin-1 (priority 20)
        expect(slots[0].owner.id).toBe('plugin-2')
        expect(slots[1].owner.id).toBe('plugin-1')
    })

    it('rejects duplicate multi-value registration by the same plugin with same contributionId', () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'plugin-1', version: '1.0.0' })
        tx.register('slot', 'banner', { text: 'Banner 1' })
        expect(() => tx.register('slot', 'banner', { text: 'Banner 2' })).toThrow(
            'Contribution conflict: slot/banner is owned by plugin-1',
        )
    })

    it('sorts multi-value contributions by priority -> pluginId -> registrationSequence', () => {
        const registry = new ContributionRegistry()

        // plugin-b with priority 100
        const txB = registry.beginActivation({ id: 'plugin-b', version: '1.0.0' })
        txB.register('slot', 's1', { label: 'B1' }, { target: 'chat.footer', priority: 100 })
        txB.register('slot', 's2', { label: 'B2' }, { target: 'chat.footer', priority: 50 })
        txB.commit()

        // plugin-a with priority 100
        const txA = registry.beginActivation({ id: 'plugin-a', version: '1.0.0' })
        txA.register('slot', 's1', { label: 'A1' }, { target: 'chat.footer', priority: 100 })
        txA.register('slot', 's2', { label: 'A2' }, { target: 'chat.footer', priority: 100 })
        txA.commit()

        // plugin-c with default priority (1000)
        const txC = registry.beginActivation({ id: 'plugin-c', version: '1.0.0' })
        txC.register('slot', 's1', { label: 'C1' }, { target: 'chat.footer' })
        txC.commit()

        const slots = registry.list<{ label: string }>('slot', 'chat.footer')
        const labels = slots.map((s) => `${s.owner.id}:${s.value.label}`)
        // Priority 50: plugin-b:B2
        // Priority 100: plugin-a:A1, plugin-a:A2 (alphabetical plugin-a before plugin-b, then sequence A1 before A2)
        // Priority 100: plugin-b:B1
        // Priority 1000: plugin-c:C1
        expect(labels).toEqual([
            'plugin-b:B2',
            'plugin-a:A1',
            'plugin-a:A2',
            'plugin-b:B1',
            'plugin-c:C1',
        ])
    })

    it('notifies subscribers once per affected kind on commit', () => {
        const registry = new ContributionRegistry()
        const slotListener = vi.fn()
        const actionListener = vi.fn()
        const viewListener = vi.fn()

        registry.subscribe('slot', slotListener)
        registry.subscribe('action', actionListener)
        registry.subscribe('view', viewListener)

        const tx = registry.beginActivation({ id: 'plug', version: '1.0.0' })
        tx.register('slot', 's1', { component: '1' })
        tx.register('slot', 's2', { component: '2' })
        tx.register('action', 'act', { title: 'A' })
        tx.commit()

        expect(slotListener).toHaveBeenCalledTimes(1)
        expect(actionListener).toHaveBeenCalledTimes(1)
        expect(viewListener).not.toHaveBeenCalled()
    })

    it('unsubscribes listeners correctly', () => {
        const registry = new ContributionRegistry()
        const listener = vi.fn()
        const unsubscribe = registry.subscribe('action', listener)

        const tx1 = registry.beginActivation({ id: 'p1', version: '1.0.0' })
        tx1.register('action', 'a1', { v: 1 })
        tx1.commit()
        expect(listener).toHaveBeenCalledTimes(1)

        unsubscribe()

        const tx2 = registry.beginActivation({ id: 'p2', version: '1.0.0' })
        tx2.register('action', 'a2', { v: 2 })
        tx2.commit()
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('revokes all contributions owned by an ownerToken and notifies affected kinds', () => {
        const registry = new ContributionRegistry()
        const actionListener = vi.fn()
        const slotListener = vi.fn()
        registry.subscribe('action', actionListener)
        registry.subscribe('slot', slotListener)

        const txA = registry.beginActivation({ id: 'pA', version: '1.0.0' })
        const tokenA = (txA as any).ownerToken as symbol
        txA.register('action', 'actA', { title: 'Action A' })
        txA.register('slot', 'slotA', { label: 'Slot A' }, { target: 'header' })
        txA.commit()

        const txB = registry.beginActivation({ id: 'pB', version: '1.0.0' })
        txB.register('action', 'actB', { title: 'Action B' })
        txB.commit()

        expect(registry.get('action', 'actA')).toEqual({ title: 'Action A' })
        expect(registry.get('action', 'actB')).toEqual({ title: 'Action B' })
        expect(registry.list('slot', 'header')).toHaveLength(1)

        actionListener.mockClear()
        slotListener.mockClear()

        registry.revokeOwner(tokenA)

        expect(registry.get('action', 'actA')).toBeUndefined()
        expect(registry.get('action', 'actB')).toEqual({ title: 'Action B' })
        expect(registry.list('slot', 'header')).toHaveLength(0)

        expect(actionListener).toHaveBeenCalledTimes(1)
        expect(slotListener).toHaveBeenCalledTimes(1)
    })

    it('handles list without target filtering', () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'p', version: '1.0.0' })
        tx.register('slot', 's1', { id: 's1' }, { target: 'header' })
        tx.register('slot', 's2', { id: 's2' }, { target: 'footer' })
        tx.commit()

        expect(registry.list('slot')).toHaveLength(2)
        expect(registry.list('slot', 'header')).toHaveLength(1)
        expect(registry.list('slot', 'sidebar')).toHaveLength(0)
    })

    it('handles get on single-value and multi-value kinds', () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'p', version: '1.0.0' })
        tx.register('rpc', 'session.get', { handler: 'rpcHandler' })
        tx.register('slot', 'custom-slot', { component: 'Custom' })
        tx.commit()

        expect(registry.get('rpc', 'session.get')).toEqual({ handler: 'rpcHandler' })
        expect(registry.get('slot', 'custom-slot')).toEqual({ component: 'Custom' })
        expect(registry.get('rpc', 'non-existent')).toBeUndefined()
    })

    it('correctly categorizes single-value contribution kinds', () => {
        const singleKinds: ContributionKind[] = [
            'service',
            'rpc',
            'action',
            'view',
            'panel',
            'tool-factory',
            'protocol',
            'model-catalog',
            'background-job',
            'storage',
        ]
        for (const kind of singleKinds) {
            expect(isSingleValueContributionKind(kind)).toBe(true)
            expect(SINGLE_VALUE_CONTRIBUTION_KINDS.has(kind)).toBe(true)
        }

        const multiKinds: ContributionKind[] = [
            'slot',
            'floating',
            'component-wrapper',
            'navigation',
            'settings-group',
            'settings',
            'composer',
            'chat-renderer',
            'resource-provider',
            'hook',
            'protocol-middleware',
            'native-event',
            'route',
            'lifecycle',
        ]
        for (const kind of multiKinds) {
            expect(isSingleValueContributionKind(kind)).toBe(false)
        }
    })

    it('handles empty commit gracefully', () => {
        const registry = new ContributionRegistry()
        const listener = vi.fn()
        registry.subscribe('action', listener)

        const tx = registry.beginActivation({ id: 'empty', version: '1.0.0' })
        const disposers = tx.commit()
        expect(disposers).toEqual([])
        expect(listener).not.toHaveBeenCalled()
    })

    it('handles listener error without breaking notification to other listeners', () => {
        const registry = new ContributionRegistry()
        const badListener = vi.fn(() => {
            throw new Error('Listener failed')
        })
        const goodListener = vi.fn()

        registry.subscribe('action', badListener)
        registry.subscribe('action', goodListener)

        const tx = registry.beginActivation({ id: 'p', version: '1.0.0' })
        tx.register('action', 'test-act', { title: 'Test' })
        expect(() => tx.commit()).not.toThrow()

        expect(badListener).toHaveBeenCalledTimes(1)
        expect(goodListener).toHaveBeenCalledTimes(1)
    })
})
