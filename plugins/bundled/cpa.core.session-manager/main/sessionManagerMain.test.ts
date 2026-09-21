import { describe, expect, it } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { sessionManagerMainEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.session-manager main entry', () => {
    it('registers services and all 21 session RPC methods on activation', async () => {
        const harness = createPluginTestHarness(sessionManagerMainEntry, {
            manifest,
        })

        await harness.activate()

        const services = harness.getRegistered('service')
        expect(services.map((s) => s.id).sort()).toEqual(['sessionRunRegistry', 'sessionService'])

        const rpcs = harness.getRegistered('rpc')
        expect(rpcs).toHaveLength(21)
        const rpcMethods = rpcs.map((r) => r.id).sort()
        expect(rpcMethods).toEqual([
            'session:abortRun',
            'session:ackDelegateRun',
            'session:broadcastResumePromptState',
            'session:broadcastRunStatus',
            'session:broadcastStreamEvent',
            'session:broadcastSubAgentState',
            'session:claimPendingDelegateRuns',
            'session:delegateRun',
            'session:delete',
            'session:get',
            'session:getActiveRuns',
            'session:getResumePromptState',
            'session:list',
            'session:listSessions',
            'session:listSessionsByScheduleId',
            'session:queryMetrics',
            'session:resumePromptAction',
            'session:search',
            'session:set',
            'session:setMeta',
            'session:updateSubAgent',
        ])
    })
})
