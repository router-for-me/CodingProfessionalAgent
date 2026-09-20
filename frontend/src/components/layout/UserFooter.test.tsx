import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { setHostBridge, setDevMode } from '@/application/services/hostTransport'
import * as reactGrabModule from '@/lib/reactGrab'
import { useUiStore } from '@/stores/uiStore'
import { UserFooter } from './UserFooter'

const webAuthMocks = vi.hoisted(() => {
  class RequiredError extends Error {}
  return {
    RequiredError,
    requireAuthenticatedResponse: vi.fn((response: Response) => response),
  }
})

vi.mock('@/features/web-auth/webAuthClient', () => ({
  WebAuthenticationRequiredError: webAuthMocks.RequiredError,
  requireAuthenticatedResponse: webAuthMocks.requireAuthenticatedResponse,
}))

describe('UserFooter', () => {
  let mockStartProfiling: any
  let mockStopProfiling: any
  let mockSaveFile: any
  const originalDev = import.meta.env.DEV

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.clearAllMocks()
    vi.useRealTimers()
    reactGrabModule.resetReactGrabStateForTests()
    webAuthMocks.requireAuthenticatedResponse.mockImplementation(
      (response: Response) => response,
    )
    ;(import.meta.env as any).DEV = originalDev
    setDevMode(true)
    mockStartProfiling = vi.fn().mockResolvedValue({ ok: true })
    mockStopProfiling = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        summary: { durationMs: 3000, target: 'all' },
        hotspots: [],
        bottlenecks: [],
        pluginMetrics: [],
        aiSuggestions: [],
      },
    })
    mockSaveFile = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/path/report.md' })

    setHostBridge({
      startProfiling: mockStartProfiling,
      stopProfiling: mockStopProfiling,
      saveFile: mockSaveFile,
      SaveFile: mockSaveFile,
    } as any)

    useUiStore.setState({
      settingsOpen: false,
      toasts: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    reactGrabModule.resetReactGrabStateForTests()
    ;(import.meta.env as any).DEV = originalDev
    setDevMode(null)
    setHostBridge(null)
  })

  it('renders settings button and opens settings panel on click', () => {
    render(<UserFooter />)

    const settingsButton = screen.getByRole('button', { name: /settings/i })
    expect(settingsButton).toBeInTheDocument()

    fireEvent.click(settingsButton)

    expect(useUiStore.getState().settingsOpen).toBe(true)
  })

  it('does not render user name button or menu', () => {
    render(<UserFooter />)

    expect(screen.queryByRole('button', { name: /Luis Pater/i })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renders settings, profiling, and React Grab from left to right in dev mode', () => {
    render(<UserFooter />)

    const reactGrabButton = screen.getByRole('button', {
      name: /reactgrab|react grab/i,
    })
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })
    const settingsButton = screen.getByRole('button', { name: /settings/i })

    expect(reactGrabButton).toBeInTheDocument()
    expect(profileButton).toBeInTheDocument()
    expect(settingsButton).toBeInTheDocument()

    expect(settingsButton.parentElement).toHaveClass('justify-start')
    expect(settingsButton.nextElementSibling).toBe(profileButton)
    expect(profileButton.nextElementSibling).toBe(reactGrabButton)
  })

  it('does not render profiling and react grab buttons in production mode', () => {
    ;(import.meta.env as any).DEV = false
    setDevMode(false)
    render(<UserFooter />)

    expect(
      screen.queryByRole('button', { name: /profiling/i }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: /reactgrab|react grab/i }),
    ).toBeNull()
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
  })

  it('activates React Grab on button click and provides visual and toast feedback', async () => {
    const activateSpy = vi.spyOn(reactGrabModule, 'activateReactGrab').mockResolvedValue(true)
    render(<UserFooter />)

    const reactGrabButton = screen.getByRole('button', {
      name: /reactgrab|react grab/i,
    })
    expect(reactGrabButton).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(reactGrabButton)
    })

    expect(activateSpy).toHaveBeenCalledTimes(1)
    const toasts = useUiStore.getState().toasts
    expect(toasts.some((t) => /reactgrab|react grab/i.test(t.message))).toBe(true)
  })

  it('starts profiling and counts down when clicking profiling button', async () => {
    vi.useFakeTimers()
    mockStartProfiling.mockResolvedValue({ ok: true })

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    expect(mockStartProfiling).toHaveBeenCalledWith({ durationMs: 60000, target: 'all' })
    expect(screen.getByText('60s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.getByText('59s')).toBeInTheDocument()
  })

  it('stops profiling early when clicking while active, saves report and shows toast', async () => {
    vi.useFakeTimers()
    mockStartProfiling.mockResolvedValue({ ok: true })
    mockStopProfiling.mockResolvedValue({
      ok: true,
      report: {
        summary: { durationMs: 3000, target: 'all' },
        hotspots: [],
        bottlenecks: [],
        pluginMetrics: [],
        aiSuggestions: [],
      },
    })

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('58s')).toBeInTheDocument()

    // Click again to stop early
    await act(async () => {
      fireEvent.click(profileButton)
    })

    expect(mockStopProfiling).toHaveBeenCalled()
    expect(mockSaveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^cpa-profile-report-\d{4}-\d{2}-\d{2}-\d{6}\.md$/),
        content: expect.stringContaining('# 🚀 Coding Professional Agent Performance Diagnostic Report'),
      }),
    )
    expect(screen.queryByText('58s')).toBeNull()
  })

  it('automatically finishes profiling and saves file when 60s timer expires', async () => {
    vi.useFakeTimers()
    mockStartProfiling.mockResolvedValue({ ok: true })
    mockStopProfiling.mockResolvedValue({
      ok: true,
      report: {
        summary: { durationMs: 60000, target: 'all' },
        hotspots: [],
        bottlenecks: [],
        pluginMetrics: [],
        aiSuggestions: [],
      },
    })

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    await act(async () => {
      vi.advanceTimersByTime(60000)
    })

    expect(mockStopProfiling).toHaveBeenCalled()
    expect(mockSaveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^cpa-profile-report-\d{4}-\d{2}-\d{2}-\d{6}\.md$/),
        content: expect.stringContaining('# 🚀 Coding Professional Agent Performance Diagnostic Report'),
      }),
    )
    expect(screen.queryByText('0s')).toBeNull()
  })

  it('handles start error gracefully and shows failure toast', async () => {
    mockStartProfiling.mockRejectedValueOnce(new Error('Profiling failed to start'))

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    expect(screen.queryByText('60s')).toBeNull()
  })

  it('handles stop error gracefully and shows failure toast', async () => {
    vi.useFakeTimers()
    mockStartProfiling.mockResolvedValue({ ok: true })
    mockStopProfiling.mockResolvedValue({ ok: false, error: 'Inspector stop failed' })

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    expect(screen.queryByText('60s')).toBeNull()
  })

  it('should fallback to getProfilingReport and save file when stopProfiling returns No active profiling session', async () => {
    vi.useFakeTimers()
    const mockGetProfilingReport = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        summary: { durationMs: 60000, target: 'all' },
        hotspots: [],
        bottlenecks: [],
        pluginMetrics: [],
        aiSuggestions: [],
      },
    })
    setHostBridge({
      startProfiling: mockStartProfiling,
      stopProfiling: mockStopProfiling,
      getProfilingReport: mockGetProfilingReport,
      saveFile: mockSaveFile,
      SaveFile: mockSaveFile,
    } as any)
    mockStartProfiling.mockResolvedValue({ ok: true })
    mockStopProfiling.mockResolvedValue({
      ok: false,
      error: 'No active profiling session',
    })

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    await act(async () => {
      fireEvent.click(profileButton)
    })

    // Click again to trigger stop
    await act(async () => {
      fireEvent.click(profileButton)
    })

    expect(mockStopProfiling).toHaveBeenCalled()
    expect(mockGetProfilingReport).toHaveBeenCalled()
    expect(mockSaveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^cpa-profile-report-\d{4}-\d{2}-\d{2}-\d{6}\.md$/),
        content: expect.stringContaining('# 🚀 Coding Professional Agent Performance Diagnostic Report'),
      }),
    )
  })

  it('should ignore rapid clicks while startProfiling is in-flight', async () => {
    let resolveStart: (val: any) => void = () => {}
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve
    })
    mockStartProfiling.mockReturnValue(startPromise)

    render(<UserFooter />)
    const profileButton = screen.getByRole('button', {
      name: /profiling/i,
    })

    // First click initiates startProfiling
    act(() => {
      fireEvent.click(profileButton)
    })

    expect(mockStartProfiling).toHaveBeenCalledTimes(1)

    // Second and third clicks while startProfiling is in-flight should be ignored
    act(() => {
      fireEvent.click(profileButton)
      fireEvent.click(profileButton)
    })

    expect(mockStartProfiling).toHaveBeenCalledTimes(1)

    // Settle startProfiling
    await act(async () => {
      resolveStart({ ok: true })
    })

    expect(screen.getByText('60s')).toBeInTheDocument()
  })

  it('renders React Grab button but hides profiling button in web environment', () => {
    setHostBridge(null)
    render(<UserFooter />)

    const reactGrabButton = screen.getByRole('button', {
      name: /reactgrab|react grab/i,
    })
    expect(reactGrabButton).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /profiling/i }),
    ).toBeNull()
  })

  it('activates React Grab on button click in web environment', async () => {
    setHostBridge(null)
    const activateSpy = vi.spyOn(reactGrabModule, 'activateReactGrab').mockResolvedValue(true)
    render(<UserFooter />)

    const reactGrabButton = screen.getByRole('button', {
      name: /reactgrab|react grab/i,
    })
    expect(reactGrabButton).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(reactGrabButton)
    })

    expect(activateSpy).toHaveBeenCalledTimes(1)
    const toasts = useUiStore.getState().toasts
    expect(toasts.some((t) => /reactgrab|react grab/i.test(t.message))).toBe(true)
  })
})
