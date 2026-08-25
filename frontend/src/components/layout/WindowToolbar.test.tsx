import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { viewRegistry } from '@/application/views/viewRegistry'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'
import { WindowToolbar } from './WindowToolbar'

let mockPathname = '/'

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown
  }) => select({ location: { pathname: mockPathname } }),
}))

beforeEach(() => {
  mockPathname = '/'
  viewRegistry.clear()
  viewRegistry.registerView({
    id: 'scheduled',
    path: '/scheduled',
    component: () => null,
    layout: {
      showComposer: false,
      rightPanelMode: 'hidden',
      reserveWindowToolbar: false,
    },
  })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, showBottomPanel: true },
  })
  useUiStore.setState({
    rightSidebarCollapsed: false,
    pinnedSummaryVisible: true,
    bottomPanelVisible: false,
  })
})

afterEach(() => {
  viewRegistry.clear()
})

describe('WindowToolbar', () => {
  it('always renders sidebar and bottom-panel actions', () => {
    render(<WindowToolbar includePinnedSummary={false} />)

    expect(screen.getByTestId('right-sidebar-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('bottom-panel-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('pinned-summary-toggle')).not.toBeInTheDocument()
  })

  it('renders maximize toggle to the left of bottom panel toggle when right sidebar is open', () => {
    useUiStore.setState({ rightSidebarCollapsed: false })
    render(<WindowToolbar includePinnedSummary={false} />)

    const toolbar = screen.getByTestId('window-toolbar')
    const buttons = toolbar.querySelectorAll('button')
    expect(buttons[0]).toHaveAttribute('data-testid', 'right-sidebar-maximize-toggle')
    expect(buttons[1]).toHaveAttribute('data-testid', 'bottom-panel-toggle')
    expect(buttons[2]).toHaveAttribute('data-testid', 'right-sidebar-toggle')
  })

  it('places the pinned-summary toggle with the window-edge pair when asked and sidebar is collapsed', () => {
    useUiStore.setState({ rightSidebarCollapsed: true })
    render(<WindowToolbar includePinnedSummary />)

    const toolbar = screen.getByTestId('window-toolbar')
    const buttons = toolbar.querySelectorAll('button')
    expect(buttons[0]).toHaveAttribute('data-testid', 'pinned-summary-toggle')
    expect(buttons[1]).toHaveAttribute('data-testid', 'bottom-panel-toggle')
    expect(buttons[2]).toHaveAttribute('data-testid', 'right-sidebar-toggle')
  })

  it('renders maximize toggle when right sidebar is open and toggles maximized state', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ rightSidebarCollapsed: false, rightSidebarMaximized: false })
    render(<WindowToolbar includePinnedSummary={false} />)

    const maxToggle = screen.getByTestId('right-sidebar-maximize-toggle')
    expect(maxToggle).toBeInTheDocument()
    expect(maxToggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(maxToggle)
    expect(useUiStore.getState().rightSidebarMaximized).toBe(true)
    expect(maxToggle).toHaveAttribute('aria-pressed', 'true')

    await user.click(maxToggle)
    expect(useUiStore.getState().rightSidebarMaximized).toBe(false)
    expect(maxToggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('hides maximize toggle when right sidebar is collapsed', () => {
    useUiStore.setState({ rightSidebarCollapsed: true })
    render(<WindowToolbar includePinnedSummary={false} />)

    expect(screen.queryByTestId('right-sidebar-maximize-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-sidebar-toggle')).toBeInTheDocument()
  })

  it('toggles the right sidebar and bottom panel independently', async () => {
    const user = userEvent.setup()
    render(<WindowToolbar includePinnedSummary />)

    await user.click(screen.getByTestId('right-sidebar-toggle'))
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)

    await user.click(screen.getByTestId('bottom-panel-toggle'))
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
    expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
    expect(useUiStore.getState().bottomPanelVisible).toBe(true)

    await user.click(screen.getByTestId('bottom-panel-toggle'))
    expect(useUiStore.getState().bottomPanelVisible).toBe(false)
  })

  it('toggles pinned summary visibility', async () => {
    const user = userEvent.setup()
    render(<WindowToolbar includePinnedSummary />)

    await user.click(screen.getByTestId('pinned-summary-toggle'))
    expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
  })

  it('hides the bottom panel toggle when showBottomPanel is false in settings', () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, showBottomPanel: false },
    })
    render(<WindowToolbar includePinnedSummary={false} />)

    expect(screen.getByTestId('right-sidebar-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('bottom-panel-toggle')).not.toBeInTheDocument()
  })

  it('hides the bottom panel toggle when terminalPosition is right', () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, showBottomPanel: true, terminalPosition: 'right' },
    })
    render(<WindowToolbar includePinnedSummary={false} />)

    expect(screen.getByTestId('right-sidebar-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('bottom-panel-toggle')).not.toBeInTheDocument()
  })

  describe('mobile browser environment', () => {
    const originalUserAgent = navigator.userAgent
    const originalMaxTouchPoints = navigator.maxTouchPoints
    const originalInnerWidth = window.innerWidth

    beforeEach(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        configurable: true,
      })
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      })
      Object.defineProperty(window, 'innerWidth', {
        value: 390,
        configurable: true,
      })
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      })
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: originalMaxTouchPoints,
        configurable: true,
      })
      Object.defineProperty(window, 'innerWidth', {
        value: originalInnerWidth,
        configurable: true,
      })
    })

    it('does NOT render right sidebar maximize toggle on mobile even when right sidebar is open', () => {
      useUiStore.setState({ rightSidebarCollapsed: false })
      render(<WindowToolbar includePinnedSummary={false} />)

      expect(
        screen.queryByTestId('right-sidebar-maximize-toggle'),
      ).not.toBeInTheDocument()
      expect(screen.getByTestId('right-sidebar-toggle')).toBeInTheDocument()
    })
  })

  it('renders nothing on /scheduled route', () => {
    mockPathname = '/scheduled'
    const { container } = render(<WindowToolbar includePinnedSummary={false} />)
    expect(container.firstChild).toBeNull()
  })
})

