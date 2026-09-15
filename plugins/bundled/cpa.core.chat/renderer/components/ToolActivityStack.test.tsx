import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import type { DisplayMessagePart } from '../types.js'
import { ToolActivityStack } from './ToolActivityStack.js'

function readPart(
  id: string,
  path: string,
  status: 'running' | 'done' = 'done',
): Extract<DisplayMessagePart, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    id,
    name: 'read',
    args: { path },
    status,
  }
}

function commandPart(
  id: string,
  command: string,
  status: 'running' | 'done' = 'done',
): Extract<DisplayMessagePart, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    id,
    name: 'bash',
    args: { command },
    status,
  }
}

function sessionTitlePart(
  id: string,
  title: string,
  status: 'running' | 'done' = 'done',
): Extract<DisplayMessagePart, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    id,
    name: 'set_session_title',
    args: { title },
    status,
  }
}

function namedToolPart(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
  status: 'running' | 'done' = 'done',
): Extract<DisplayMessagePart, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    id,
    name,
    args,
    status,
  }
}

describe('ToolActivityStack', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('shows only the latest summary until history is expanded', () => {
    render(
      <ToolActivityStack
        parts={[
          readPart('t1', '/skills/gh-issue/SKILL.md'),
          readPart('t2', 'openai_images_handlers.go', 'running'),
        ]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent(
      'Reading openai_images_handlers.go',
    )
    expect(screen.queryByText('Read Gh Issue skill')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-status')).not.toBeInTheDocument()
    expect(screen.getByTestId('tool-activity-expand')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('collapses finished tool runs to the latest summary', () => {
    render(
      <ToolActivityStack
        parts={[
          readPart('t1', '/skills/gh-issue/SKILL.md'),
          readPart('t2', 'openai_compat_executor.go'),
          readPart('t3', 'codex_openai_images.go'),
        ]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent(
      'Read codex_openai_images.go',
    )
    expect(screen.queryByText('Read openai_compat_executor.go')).not.toBeInTheDocument()
    expect(screen.queryByText('Used 3 tools')).not.toBeInTheDocument()
  })

  it('hides the expand arrow when there is no folded history', () => {
    render(
      <ToolActivityStack
        parts={[readPart('t1', 'main.go')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent(
      'Read main.go',
    )
    expect(screen.queryByTestId('tool-activity-expand')).not.toBeInTheDocument()
  })

  it('expands historical summaries then tool details', () => {
    render(
      <ToolActivityStack
        parts={[
          readPart('t1', '/skills/gh-issue/SKILL.md'),
          readPart('t2', 'main.go'),
        ]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    fireEvent.click(screen.getByTestId('tool-activity-expand'))
    expect(screen.getByTestId('tool-activity-expand')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByTestId('tool-activity-history')).toBeInTheDocument()
    expect(screen.getByText('Read Gh Issue skill')).toBeInTheDocument()
    const summaries = screen.getAllByTestId('tool-activity-summary')
    expect(summaries).toHaveLength(2)
    expect(summaries[1]).toHaveTextContent('Read main.go')
    expect(screen.queryByTestId('tool-status')).not.toBeInTheDocument()

    fireEvent.click(summaries[1]!)
    expect(screen.getByTestId('tool-status')).toBeInTheDocument()
    expect(screen.getByTestId('tool-args')).toHaveTextContent('main.go')
  })

  it('opens a single tool summary into its details card', () => {
    render(
      <ToolActivityStack
        parts={[readPart('t1', 'main.go')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    fireEvent.click(screen.getByTestId('tool-activity-summary'))
    expect(screen.getByTestId('tool-status')).toBeInTheDocument()
    expect(screen.getByTestId('tool-args')).toHaveTextContent('main.go')
  })

  it('renders running command with wrench icon and running label', () => {
    const { container } = render(
      <ToolActivityStack
        parts={[commandPart('t1', 'rg "responses_response"', 'running')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const latest = screen.getByTestId('tool-activity-latest')
    expect(latest).toHaveTextContent('Running rg "responses_response"')
    expect(latest).toHaveClass('animate-text-shimmer')
    const wrench = container.querySelector('.lucide-wrench')
    expect(wrench).toBeInTheDocument()
    const square = container.querySelector('.lucide-square')
    expect(square).not.toBeInTheDocument()
  })

  it('prefers a canonical terminal status over a stale running overlay', () => {
    render(
      <ToolActivityStack
        parts={[commandPart('t1', 'git status', 'done')]}
        toolOverlays={{
          t1: {
            toolCallId: 't1',
            status: 'running',
          },
        }}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const latest = screen.getByTestId('tool-activity-latest')
    expect(latest).toHaveTextContent('Loaded tools and ran a command')
    expect(latest).not.toHaveTextContent('Running git status')
    expect(latest).not.toHaveClass('animate-text-shimmer')
  })

  it('applies animate-text-shimmer class to running tool summaries in both collapsed and expanded states', () => {
    render(
      <ToolActivityStack
        parts={[
          readPart('t1', 'main.go', 'done'),
          readPart('t2', 'antigravity_openai_request.go', 'running'),
        ]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('tool-activity-latest')
    expect(header).toHaveClass('animate-text-shimmer')

    fireEvent.click(screen.getByTestId('tool-activity-expand'))
    const history = screen.getByTestId('tool-activity-history')
    const spans = history.querySelectorAll('span.truncate')
    expect(spans).toHaveLength(2)
    expect(spans[0]).not.toHaveClass('animate-text-shimmer')
    expect(spans[1]).toHaveClass('animate-text-shimmer')
  })

  it('applies animate-text-shimmer to latest and last folded item when streaming is true even if status is done', () => {
    render(
      <ToolActivityStack
        parts={[
          readPart('t1', 'main.go', 'done'),
          readPart('t2', 'usage_helpers.go', 'done'),
        ]}
        streaming
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('tool-activity-latest')
    expect(header).toHaveTextContent('Read usage_helpers.go')
    expect(header).toHaveClass('animate-text-shimmer')

    fireEvent.click(screen.getByTestId('tool-activity-expand'))
    const history = screen.getByTestId('tool-activity-history')
    const spans = history.querySelectorAll('span.truncate')
    expect(spans).toHaveLength(2)
    expect(spans[0]).not.toHaveClass('animate-text-shimmer')
    expect(spans[1]).toHaveClass('animate-text-shimmer')
  })

  it('does not apply animate-text-shimmer class when all tools are done and not streaming', () => {
    render(
      <ToolActivityStack
        parts={[
          readPart('t1', 'main.go', 'done'),
          readPart('t2', 'usage_helpers.go', 'done'),
        ]}
        streaming={false}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('tool-activity-latest')
    expect(header).not.toHaveClass('animate-text-shimmer')

    fireEvent.click(screen.getByTestId('tool-activity-expand'))
    const history = screen.getByTestId('tool-activity-history')
    const spans = history.querySelectorAll('span.truncate')
    expect(spans[0]).not.toHaveClass('animate-text-shimmer')
    expect(spans[1]).not.toHaveClass('animate-text-shimmer')
  })

  it('renders set_session_title with descriptive title in latest summary and expanded history', () => {
    render(
      <ToolActivityStack
        parts={[
          sessionTitlePart('t1', 'Refactor login module', 'done'),
          readPart('t2', 'main.go', 'done'),
        ]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent('Read main.go')

    fireEvent.click(screen.getByTestId('tool-activity-expand'))
    const history = screen.getByTestId('tool-activity-history')
    expect(history).toHaveTextContent('Set session title to Refactor login module')
    expect(history).toHaveTextContent('Read main.go')
    expect(screen.queryByText('Used set_session_title')).not.toBeInTheDocument()
  })

  it('renders standalone set_session_title in collapsed latest summary', () => {
    render(
      <ToolActivityStack
        parts={[sessionTitlePart('t1', 'Fix session title display', 'done')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent('Set session title to Fix session title display')
    expect(screen.queryByText('Used set_session_title')).not.toBeInTheDocument()
  })

  it('shows localized copy for built-in memory and web search tools', () => {
    render(
      <ToolActivityStack
        parts={[namedToolPart('t1', 'memories_search', { queries: ['preference'] })]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent('Searched memories')
    expect(screen.queryByText(/memories_search/)).not.toBeInTheDocument()
  })

  it('shows Chinese copy for built-in tools instead of function names', async () => {
    await i18n.changeLanguage('zh-CN')
    render(
      <ToolActivityStack
        parts={[
          namedToolPart('t1', 'memories_list'),
          namedToolPart('t2', 'web_search', { query: 'latest release' }, 'running'),
        ]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity-latest')).toHaveTextContent('正在在线搜索')
    expect(screen.queryByText(/web_search/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('tool-activity-expand'))
    expect(screen.getByTestId('tool-activity-history')).toHaveTextContent('已列出记忆')
    expect(screen.queryByText(/memories_list/)).not.toBeInTheDocument()
  })
})
