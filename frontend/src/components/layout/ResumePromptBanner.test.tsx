import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { useResumePromptStore } from '@/stores/resumePromptStore'
import { setHostBridge } from '@/application/services/hostTransport'
import { ResumePromptBanner } from './ResumePromptBanner'

describe('ResumePromptBanner', () => {
  beforeEach(async () => {
    setHostBridge(null)
    await i18n.changeLanguage('en')
    useResumePromptStore.getState().closePrompt()
  })

  it('renders nothing when prompt is not open', () => {
    render(<ResumePromptBanner />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('renders prompt message with count and countdown, and buttons', () => {
    useResumePromptStore.getState().openPrompt({
      totalCount: 2,
      countdown: 30,
      unfinishedSessionIds: ['s1'],
      unfinishedSubAgentIds: ['sa1'],
      onContinue: () => {},
      onAbort: () => {},
    })

    render(<ResumePromptBanner />)

    expect(screen.getByRole('region')).toBeInTheDocument()
    expect(
      screen.getByText('2 unfinished item(s) detected, resuming in 30s'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Do not resume' })).toBeInTheDocument()
  })

  it('triggers onContinue when Resume now is clicked', async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    const onAbort = vi.fn()

    useResumePromptStore.getState().openPrompt({
      totalCount: 1,
      countdown: 25,
      unfinishedSessionIds: ['s1'],
      unfinishedSubAgentIds: [],
      onContinue,
      onAbort,
    })

    render(<ResumePromptBanner />)

    const continueBtn = screen.getByRole('button', { name: 'Resume now' })
    await user.click(continueBtn)

    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onAbort).not.toHaveBeenCalled()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
  })

  it('triggers onAbort when Do not resume is clicked', async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    const onAbort = vi.fn()

    useResumePromptStore.getState().openPrompt({
      totalCount: 1,
      countdown: 25,
      unfinishedSessionIds: ['s1'],
      unfinishedSubAgentIds: [],
      onContinue,
      onAbort,
    })

    render(<ResumePromptBanner />)

    const abortBtn = screen.getByRole('button', { name: 'Do not resume' })
    await user.click(abortBtn)

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onContinue).not.toHaveBeenCalled()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
  })

  it('delegates action to host bridge when clicked in web browser environment without local actions', async () => {
    const user = userEvent.setup()
    const mockAction = vi.fn().mockResolvedValue(undefined)
    setHostBridge({
      SessionResumePromptAction: mockAction,
    } as any)

    useResumePromptStore.getState().syncState({
      isOpen: true,
      totalCount: 3,
      countdown: 18,
      unfinishedSessionIds: ['s1', 's2', 's3'],
    })

    render(<ResumePromptBanner />)

    expect(
      screen.getByText('3 unfinished item(s) detected, resuming in 18s'),
    ).toBeInTheDocument()

    const continueBtn = screen.getByRole('button', { name: 'Resume now' })
    await user.click(continueBtn)

    expect(mockAction).toHaveBeenCalledWith('continue')
    expect(useResumePromptStore.getState().isOpen).toBe(false)
  })
})
