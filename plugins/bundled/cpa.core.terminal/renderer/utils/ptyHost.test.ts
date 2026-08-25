import { describe, expect, it, vi } from 'vitest'
import {
    base64ToBytes,
    bytesToBase64,
    startPtySession,
    type NativeEventSource,
    type NativePtyEvent,
    type PtyBindings,
} from './ptyHost.js'

describe('ptyHost', () => {
    it('encodes and decodes base64 bytes correctly', () => {
        const text = 'hello world'
        const bytes = new TextEncoder().encode(text)
        const b64 = bytesToBase64(bytes)
        const roundtrip = base64ToBytes(b64)
        expect(new TextDecoder().decode(roundtrip)).toBe(text)
    })

    it('starts PTY session, receives stdout data and exits on exit event', async () => {
        let eventListener: ((event: NativePtyEvent) => void) | null = null
        const events: NativeEventSource = {
            on: (listener) => {
                eventListener = listener
                return () => {
                    eventListener = null
                }
            },
        }

        const bindings: PtyBindings = {
            StartPty: vi.fn(async () => {}),
            WritePty: vi.fn(async () => {}),
            ResizePty: vi.fn(async () => {}),
            ClosePty: vi.fn(async () => {}),
            CancelOperation: vi.fn(async () => {}),
        }

        const onData = vi.fn()
        const onExit = vi.fn()

        const session = await startPtySession(
            {
                operationId: 'op-1',
                cwd: '/workspace',
                cols: 80,
                rows: 24,
                onData,
                onExit,
            },
            bindings,
            events,
        )

        expect(bindings.StartPty).toHaveBeenCalledWith({
            operationId: 'op-1',
            cwd: '/workspace',
            cols: 80,
            rows: 24,
            shell: undefined,
        })

        // Emit stdout data
        const testData = new TextEncoder().encode('prompt $ ')
        eventListener?.({
            kind: 'pty-stdout',
            operationId: 'op-1',
            data: bytesToBase64(testData),
            encoding: 'base64',
        })

        expect(new TextDecoder().decode(onData.mock.calls[0]![0])).toBe('prompt $ ')

        // Write input
        await session.write('ls\n')
        expect(bindings.WritePty).toHaveBeenCalledWith(
            'op-1',
            bytesToBase64(new TextEncoder().encode('ls\n')),
        )

        // Resize
        await session.resize(100, 30)
        expect(bindings.ResizePty).toHaveBeenCalledWith('op-1', 100, 30)

        // Emit exit event (native pty service uses kind "done")
        eventListener?.({
            kind: 'done',
            operationId: 'op-1',
            exitCode: 0,
        })
        expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'done' }))

        // Active session disposal calls ClosePty
        const activeSession = await startPtySession(
            {
                operationId: 'op-2',
                cwd: '/workspace',
                cols: 80,
                rows: 24,
                onData: vi.fn(),
                onExit: vi.fn(),
            },
            bindings,
            events,
        )
        await activeSession.dispose()
        expect(bindings.ClosePty).toHaveBeenCalledWith('op-2')
    })
})
