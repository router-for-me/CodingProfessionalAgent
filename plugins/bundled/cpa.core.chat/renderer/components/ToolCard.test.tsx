import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ToolCard, type ToolCardPart } from './ToolCard.js'

function part(overrides: Partial<ToolCardPart> = {}): ToolCardPart {
  return {
    type: 'tool_call',
    id: 'tool-1',
    name: 'bash',
    args: { command: 'echo hi' },
    status: 'running',
    ...overrides,
  }
}

describe('ToolCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  const statuses = [
    'queued',
    'running',
    'awaiting_approval',
    'done',
    'error',
    'rejected',
    'aborted',
  ] as const

  it.each(statuses)('renders %s status badge', (status) => {
    render(
      <ToolCard
        part={part({ status })}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )
    expect(screen.getByTestId('tool-status')).toHaveAttribute(
      'data-tool-status',
      status,
    )
  })

  it('allows statusOverride for live Task18 status not stored in projection', () => {
    render(
      <ToolCard
        part={part({ status: 'done' })}
        statusOverride="queued"
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )
    expect(screen.getByTestId('tool-status')).toHaveAttribute(
      'data-tool-status',
      'queued',
    )
  })

  it('shows bash partial tail as preformatted output', () => {
    render(
      <ToolCard
        part={part({ name: 'bash', status: 'running' })}
        partialOutput={'line1\nline2\nline3'}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )
    const pre = screen.getByTestId('tool-partial-output')
    expect(pre.tagName).toBe('PRE')
    expect(pre).toHaveTextContent('line3')
  })

  it('shows edit details diff or patch content', () => {
    render(
      <ToolCard
        part={part({
          name: 'edit',
          args: { path: 'a.ts' },
          status: 'done',
        })}
        details={{ diff: '@@ -1 +1 @@\n-old\n+new' }}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )
    expect(screen.getByTestId('tool-diff')).toHaveTextContent('+new')
  })

  it('renders read image results as data-url previews with alt text', () => {
    render(
      <ToolCard
        part={part({ name: 'read', status: 'done' })}
        resultImages={[
          {
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
            alt: 'diagram.png',
          },
        ]}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )
    const image = screen.getByRole('img', { name: 'diagram.png' })
    expect(image).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=')
  })

  it('shows text tool results and approval actions', () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    render(
      <ToolCard
        part={part({
          status: 'awaiting_approval',
          result: 'ok output',
        })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    expect(screen.getByText('ok output')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Approve/i }))
    fireEvent.click(screen.getByRole('button', { name: /Reject/i }))
    expect(onApprove).toHaveBeenCalledWith('tool-1')
    expect(onReject).toHaveBeenCalledWith('tool-1')
  })

  it('expands long args/results and stringifies cycles and BigInt safely', () => {
    const cyclic: Record<string, unknown> = { n: 1n }
    cyclic.self = cyclic

    render(
      <ToolCard
        part={part({
          args: cyclic,
          result: 'x'.repeat(500),
          status: 'done',
        })}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-args')).toBeInTheDocument()
    expect(screen.getByTestId('tool-args').textContent).toMatch(/Circular|1/)

    const expand = screen.getByRole('button', { name: /Expand/i })
    fireEvent.click(expand)
    expect(screen.getByTestId('tool-result')).toHaveTextContent('x'.repeat(40))
  })

  it('never uses dangerouslySetInnerHTML for tool payloads', () => {
    const { container } = render(
      <ToolCard
        part={part({
          args: { html: '<img src=x onerror=alert(1)>' },
          result: '<script>alert(1)</script>',
          status: 'done',
        })}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    )
    expect(container.querySelector('[dangerouslysetinnerhtml]')).toBeNull()
    expect(container.querySelectorAll('img, script')).toHaveLength(0)
    expect(screen.getByTestId('tool-result').textContent).toContain('<script>')
  })
})
