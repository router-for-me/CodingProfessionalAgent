import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '@/stores/uiStore'
import { ToastHost } from './ToastHost'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('ToastHost recovery actions', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        useUiStore.setState({ toasts: [] })
    })

    afterEach(() => {
        vi.useRealTimers()
        useUiStore.setState({ toasts: [] })
    })

    it('keeps a recovery action available until its owner resolves the conflict', () => {
        const recover = vi.fn()
        const id = useUiStore.getState().pushToast('History conflict', { label: 'Preserve & reload', run: recover })
        render(<ToastHost />)
        act(() => vi.advanceTimersByTime(10_000))
        fireEvent.click(screen.getByRole('button', { name: 'Preserve & reload' }))
        expect(recover).toHaveBeenCalledTimes(1)
        expect(useUiStore.getState().toasts).toHaveLength(1)
        act(() => useUiStore.getState().dismissToast(id))
        expect(screen.queryByText('History conflict')).toBeNull()
    })

    it('still dismisses ordinary informational toasts automatically', () => {
        useUiStore.getState().pushToast('Saved')
        render(<ToastHost />)
        act(() => vi.advanceTimersByTime(3_200))
        expect(screen.queryByText('Saved')).toBeNull()
    })
})
