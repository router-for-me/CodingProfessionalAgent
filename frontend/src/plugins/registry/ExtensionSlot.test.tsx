import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import React from 'react'
import { RendererRegistry } from '../platform/rendererRegistry'
import { ExtensionSlot } from './ExtensionSlot'
import { SlotErrorBoundary } from './SlotErrorBoundary'

describe('ExtensionSlot & SlotErrorBoundary', () => {
    let registry: RendererRegistry
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        registry = new RendererRegistry()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        consoleErrorSpy.mockRestore()
    })

    describe('Fallback rendering', () => {
        it('renders fallback when no contributions are registered', () => {
            render(
                <ExtensionSlot
                    name="empty.slot"
                    registry={registry}
                    fallback={<div data-testid="fallback">No items</div>}
                />
            )

            expect(screen.getByTestId('fallback')).toBeInTheDocument()
            expect(screen.getByTestId('fallback')).toHaveTextContent('No items')
        })

        it('renders null / nothing when no contributions and no fallback provided', () => {
            const { container } = render(
                <ExtensionSlot name="empty.slot" registry={registry} />
            )

            expect(container).toBeEmptyDOMElement()
        })

        it('renders fallback when contributions exist but all are hidden by visible predicate', () => {
            const HiddenComponent: React.FC = () => <div>Hidden Content</div>

            registry.registerSlot('test.slot', {
                id: 'hidden-item',
                pluginId: 'plugin-1',
                component: HiddenComponent,
                visible: () => false,
            })

            render(
                <ExtensionSlot
                    name="test.slot"
                    registry={registry}
                    fallback={<div data-testid="fallback">All hidden</div>}
                />
            )

            expect(screen.getByTestId('fallback')).toBeInTheDocument()
            expect(screen.queryByText('Hidden Content')).not.toBeInTheDocument()
        })
    })

    describe('Multiple components rendering in order', () => {
        it('renders multiple contributions in ascending order', () => {
            const ItemA: React.FC = () => <div data-testid="item-a">Item A (200)</div>
            const ItemB: React.FC = () => <div data-testid="item-b">Item B (50)</div>
            const ItemC: React.FC = () => <div data-testid="item-c">Item C (100)</div>

            registry.registerSlot('test.order', {
                id: 'item-a',
                pluginId: 'plugin-a',
                order: 200,
                component: ItemA,
            })
            registry.registerSlot('test.order', {
                id: 'item-b',
                pluginId: 'plugin-b',
                order: 50,
                component: ItemB,
            })
            registry.registerSlot('test.order', {
                id: 'item-c',
                pluginId: 'plugin-c',
                order: 100,
                component: ItemC,
            })

            render(<ExtensionSlot name="test.order" registry={registry} />)

            const items = screen.getAllByTestId(/item-[abc]/)
            expect(items).toHaveLength(3)
            expect(items[0]).toHaveAttribute('data-testid', 'item-b')
            expect(items[1]).toHaveAttribute('data-testid', 'item-c')
            expect(items[2]).toHaveAttribute('data-testid', 'item-a')
        })
    })

    describe('Props passing', () => {
        it('passes props to slot components correctly', () => {
            interface ButtonSlotProps {
                label: string
                count: number
            }

            const ButtonItem: React.FC<ButtonSlotProps> = ({ label, count }) => (
                <button type="button" data-testid="prop-btn">
                    {label}: {count}
                </button>
            )

            registry.registerSlot<ButtonSlotProps>('button.slot', {
                id: 'btn-item',
                pluginId: 'plugin-btn',
                component: ButtonItem,
            })

            render(
                <ExtensionSlot<ButtonSlotProps>
                    name="button.slot"
                    registry={registry}
                    props={{ label: 'Clicks', count: 42 }}
                />
            )

            const btn = screen.getByTestId('prop-btn')
            expect(btn).toHaveTextContent('Clicks: 42')
        })
    })

    describe('Dynamic visible condition', () => {
        it('evaluates visible condition with slot props', () => {
            interface ModeProps {
                mode: 'edit' | 'view'
            }

            const EditTool: React.FC<ModeProps> = () => (
                <span data-testid="edit-tool">Edit Action</span>
            )

            registry.registerSlot<ModeProps>('toolbar.slot', {
                id: 'edit-action',
                pluginId: 'editor-plugin',
                component: EditTool,
                visible: (ctx) => ctx.mode === 'edit',
            })

            const { rerender } = render(
                <ExtensionSlot<ModeProps>
                    name="toolbar.slot"
                    registry={registry}
                    props={{ mode: 'view' }}
                />
            )

            expect(screen.queryByTestId('edit-tool')).not.toBeInTheDocument()

            rerender(
                <ExtensionSlot<ModeProps>
                    name="toolbar.slot"
                    registry={registry}
                    props={{ mode: 'edit' }}
                />
            )

            expect(screen.getByTestId('edit-tool')).toBeInTheDocument()
        })
    })

    describe('renderWrapper & className', () => {
        it('uses renderWrapper when provided to customize layout', () => {
            const Item: React.FC = () => <span>Nav Item</span>

            registry.registerSlot('nav.slot', {
                id: 'nav-1',
                pluginId: 'nav-plugin',
                component: Item,
            })

            render(
                <ExtensionSlot
                    name="nav.slot"
                    registry={registry}
                    renderWrapper={(items) => (
                        <nav data-testid="custom-nav" className="flex gap-4">
                            {items}
                        </nav>
                    )}
                />
            )

            const nav = screen.getByTestId('custom-nav')
            expect(nav).toBeInTheDocument()
            expect(nav).toHaveClass('flex', 'gap-4')
            expect(nav).toHaveTextContent('Nav Item')
        })

        it('wraps items with className div when className is provided without renderWrapper', () => {
            const Item: React.FC = () => <span>Slot Child</span>

            registry.registerSlot('styled.slot', {
                id: 'styled-1',
                pluginId: 'styled-plugin',
                component: Item,
            })

            const { container } = render(
                <ExtensionSlot
                    name="styled.slot"
                    registry={registry}
                    className="space-y-2 p-4"
                />
            )

            const wrapper = container.querySelector('.space-y-2.p-4')
            expect(wrapper).toBeInTheDocument()
            expect(wrapper).toHaveTextContent('Slot Child')
        })
    })

    describe('SlotErrorBoundary isolation', () => {
        it('isolates crashing component and renders fallback containing contributionId', () => {
            const GoodComponent: React.FC = () => (
                <div data-testid="good-comp">Healthy Component</div>
            )
            const BrokenComponent: React.FC = () => {
                throw new Error('Component crashed during render')
            }

            registry.registerSlot('mixed.slot', {
                id: 'broken-item',
                pluginId: 'buggy-plugin',
                order: 1,
                component: BrokenComponent,
            })
            registry.registerSlot('mixed.slot', {
                id: 'good-item',
                pluginId: 'good-plugin',
                order: 2,
                component: GoodComponent,
            })

            render(<ExtensionSlot name="mixed.slot" registry={registry} />)

            // Good component still renders properly
            expect(screen.getByTestId('good-comp')).toBeInTheDocument()

            // Broken component error fallback contains contributionId
            const errorFallback = screen.getByTestId('slot-error-broken-item')
            expect(errorFallback).toBeInTheDocument()
            expect(errorFallback).toHaveTextContent('broken-item')
        })

        it('supports standalone SlotErrorBoundary with custom fallback', () => {
            const Crasher: React.FC = () => {
                throw new Error('Boom!')
            }

            render(
                <SlotErrorBoundary
                    contributionId="custom-crash-id"
                    fallback={<div data-testid="custom-error">Custom Crash UI</div>}
                >
                    <Crasher />
                </SlotErrorBoundary>
            )

            expect(screen.getByTestId('custom-error')).toBeInTheDocument()
            expect(screen.getByTestId('custom-error')).toHaveTextContent('Custom Crash UI')
        })

        it('allows resetting error state by clicking Retry button in fallback UI', () => {
            let shouldThrow = true
            const FlakyComponent: React.FC = () => {
                if (shouldThrow) {
                    throw new Error('Transient render error')
                }
                return <div data-testid="recovered-comp">Recovered!</div>
            }

            render(
                <SlotErrorBoundary contributionId="flaky-item">
                    <FlakyComponent />
                </SlotErrorBoundary>
            )

            const errorFallback = screen.getByTestId('slot-error-flaky-item')
            expect(errorFallback).toBeInTheDocument()
            expect(screen.getByText('Retry')).toBeInTheDocument()

            // Fix error condition and click retry
            shouldThrow = false
            fireEvent.click(screen.getByText('Retry'))

            expect(screen.getByTestId('recovered-comp')).toBeInTheDocument()
            expect(screen.queryByTestId('slot-error-flaky-item')).not.toBeInTheDocument()
        })
    })

    describe('Dynamic registration and unregistration reactivity', () => {
        it('dynamically renders newly registered slot items and cleans up on unregister', () => {
            const DynamicItem: React.FC = () => <div data-testid="dyn-item">Live Item</div>

            render(<ExtensionSlot name="live.slot" registry={registry} />)
            expect(screen.queryByTestId('dyn-item')).not.toBeInTheDocument()

            let unregister: () => void = () => {}
            act(() => {
                unregister = registry.registerSlot('live.slot', {
                    id: 'dyn-1',
                    pluginId: 'dyn-plugin',
                    component: DynamicItem,
                })
            })

            expect(screen.getByTestId('dyn-item')).toBeInTheDocument()

            act(() => {
                unregister()
            })

            expect(screen.queryByTestId('dyn-item')).not.toBeInTheDocument()
        })
    })
})
