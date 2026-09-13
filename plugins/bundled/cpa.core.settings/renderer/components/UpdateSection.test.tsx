import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { UpdateSection } from './UpdateSection.js'
import { setSettingsCapabilityClient } from '../utils/capability.js'

describe('UpdateSection', () => {
    it('renders current version and check for update button', () => {
        const onCheckUpdates = vi.fn()
        render(<UpdateSection currentVersion="1.0.0" phase="idle" onCheckUpdates={onCheckUpdates} />)

        expect(screen.getByText(/1\.0\.0/)).toBeDefined()
        const checkBtn = screen.getByRole('button', { name: /检查更新|Check for updates/i })
        expect(checkBtn).toBeDefined()

        fireEvent.click(checkBtn)
        expect(onCheckUpdates).toHaveBeenCalled()
    })

    it('renders checking state when checking for updates', () => {
        render(<UpdateSection currentVersion="1.0.0" phase="checking" />)
        expect(screen.getByText(/正在检查更新|Checking for updates/i)).toBeDefined()
    })

    it('renders hot update badge and release notes when update is available', () => {
        const onDownload = vi.fn()
        render(
            <UpdateSection
                currentVersion="1.0.0"
                phase="available"
                availableVersion="1.1.0"
                updateType="hot"
                releaseNotes="Fix critical bug and improve performance"
                onDownload={onDownload}
            />,
        )

        expect(screen.getByText(/1\.1\.0/)).toBeDefined()
        expect(screen.getByText(/热更新 \(~25MB\)|Hot Update \(~25MB\)/i)).toBeDefined()
        expect(screen.getByText(/Fix critical bug and improve performance/)).toBeDefined()

        const downloadBtn = screen.getByRole('button', { name: /下载更新|Download Update/i })
        expect(downloadBtn).toBeDefined()
        fireEvent.click(downloadBtn)
        expect(onDownload).toHaveBeenCalled()
    })

    it('renders full package update badge when update is full type', () => {
        render(
            <UpdateSection
                currentVersion="1.0.0"
                phase="available"
                availableVersion="2.0.0"
                updateType="full"
            />,
        )

        expect(screen.getByText(/2\.0\.0/)).toBeDefined()
        expect(screen.getByText(/全量安装包更新|Full Package Update/i)).toBeDefined()
    })

    it('renders progress bar when downloading', () => {
        const onCancel = vi.fn()
        render(
            <UpdateSection
                currentVersion="1.0.0"
                phase="downloading"
                downloadProgress={{
                    percent: 45,
                    transferredBytes: 4500,
                    totalBytes: 10000,
                    bytesPerSecond: 500,
                }}
                onCancel={onCancel}
            />,
        )

        expect(screen.getByText(/45%/)).toBeDefined()
        const cancelBtn = screen.getByRole('button', { name: /取消|Cancel/i })
        expect(cancelBtn).toBeDefined()
        fireEvent.click(cancelBtn)
        expect(onCancel).toHaveBeenCalled()
    })

    it('renders ready state and restart to apply update button', () => {
        const onApply = vi.fn()
        render(
            <UpdateSection
                currentVersion="1.0.0"
                phase="ready"
                availableVersion="1.1.0"
                onApply={onApply}
            />,
        )

        expect(screen.getByText(/更新已就绪|ready to install/i)).toBeDefined()
        const restartBtn = screen.getByRole('button', {
            name: /立即重启以应用更新|Restart to Apply Update|立即重启/i,
        })
        expect(restartBtn).toBeDefined()
        fireEvent.click(restartBtn)
        expect(onApply).toHaveBeenCalled()
    })

    it('renders error state and retry button', () => {
        const onCheckUpdates = vi.fn()
        render(
            <UpdateSection
                currentVersion="1.0.0"
                phase="error"
                errorMessage="Network timeout"
                onCheckUpdates={onCheckUpdates}
            />,
        )

        expect(screen.getByText(/Network timeout/)).toBeDefined()
        const retryBtn = screen.getByRole('button', { name: /重试|Retry/i })
        expect(retryBtn).toBeDefined()
        fireEvent.click(retryBtn)
        expect(onCheckUpdates).toHaveBeenCalled()
    })

    it('queries update:getState and handles check when uncontrolled with capability client', async () => {
        const invokeMock = vi.fn().mockImplementation((method: string) => {
            if (method === 'update:getState') {
                return Promise.resolve({
                    phase: 'idle',
                    currentVersion: '1.2.3',
                })
            }
            if (method === 'update:check') {
                return Promise.resolve({
                    phase: 'available',
                    currentVersion: '1.2.3',
                    availableVersion: '1.3.0',
                    updateType: 'hot',
                    releaseNotes: 'New awesome feature',
                })
            }
            return Promise.resolve()
        })
        const subscribeMock = vi.fn().mockReturnValue(() => {})

        setSettingsCapabilityClient({
            invoke: invokeMock,
            subscribe: subscribeMock,
            has: () => true,
        } as any)

        render(<UpdateSection />)

        expect(invokeMock).toHaveBeenCalledWith('update:getState')
        expect(subscribeMock).toHaveBeenCalledWith('update:status-changed', expect.any(Function))

        const checkBtn = await screen.findByRole('button', { name: /检查更新|Check for updates/i })
        fireEvent.click(checkBtn)

        expect(invokeMock).toHaveBeenCalledWith('update:check')
        expect(await screen.findByText(/1\.3\.0/)).toBeDefined()
        expect(await screen.findByText(/热更新 \(~25MB\)|Hot Update \(~25MB\)/i)).toBeDefined()

        setSettingsCapabilityClient(null)
    })

    it('updates state when native update:status-changed event is emitted', async () => {
        let eventListener: ((event: any) => void) | null = null
        const invokeMock = vi.fn().mockImplementation((method: string) => {
            if (method === 'update:getState') {
                return Promise.resolve({
                    phase: 'idle',
                    currentVersion: '1.0.0',
                })
            }
            return Promise.resolve()
        })
        const subscribeMock = vi.fn().mockImplementation((_channel: string, listener: any) => {
            eventListener = listener
            return () => {}
        })

        setSettingsCapabilityClient({
            invoke: invokeMock,
            subscribe: subscribeMock,
            has: () => true,
        } as any)

        render(<UpdateSection />)

        expect(eventListener).toBeDefined()

        act(() => {
            eventListener?.({
                kind: 'update:status-changed',
                data: JSON.stringify({
                    phase: 'downloading',
                    currentVersion: '1.0.0',
                    downloadProgress: {
                        percent: 78,
                        transferredBytes: 7800,
                        totalBytes: 10000,
                        bytesPerSecond: 1200,
                    },
                }),
            })
        })

        expect(await screen.findByText(/78%/)).toBeDefined()

        setSettingsCapabilityClient(null)
    })

    it('does not overwrite newer state from subscription when delayed getState resolves', async () => {
        let eventListener: ((event: any) => void) | null = null
        let resolveGetState: ((value: any) => void) | null = null

        const invokeMock = vi.fn().mockImplementation((method: string) => {
            if (method === 'update:getState') {
                return new Promise((resolve) => {
                    resolveGetState = resolve
                })
            }
            return Promise.resolve()
        })
        const subscribeMock = vi.fn().mockImplementation((_channel: string, listener: any) => {
            eventListener = listener
            return () => {}
        })

        setSettingsCapabilityClient({
            invoke: invokeMock,
            subscribe: subscribeMock,
            has: () => true,
        } as any)

        render(<UpdateSection />)

        expect(invokeMock).toHaveBeenCalledWith('update:getState')
        expect(eventListener).toBeDefined()

        // 1. Subscription emits a live event (e.g. downloading at 60%) before getState finishes
        act(() => {
            eventListener?.({
                kind: 'update:status-changed',
                data: JSON.stringify({
                    phase: 'downloading',
                    currentVersion: '1.0.0',
                    downloadProgress: {
                        percent: 60,
                        transferredBytes: 6000,
                        totalBytes: 10000,
                        bytesPerSecond: 1000,
                    },
                }),
            })
        })

        // UI should show the downloading state (60%)
        expect(await screen.findByText(/60%/)).toBeDefined()

        // 2. Delayed getState now resolves with older 'idle' state
        await act(async () => {
            resolveGetState?.({
                phase: 'idle',
                currentVersion: '1.0.0',
            })
        })

        // The newer 'downloading' state must NOT have been overwritten by stale getState
        expect(screen.getByText(/60%/)).toBeDefined()
        expect(screen.queryByText(/检查更新|Check for updates/i)).toBeNull()

        setSettingsCapabilityClient(null)
    })
})
