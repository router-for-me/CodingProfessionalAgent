import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import React from 'react'
import { RendererRegistry, rendererRegistry } from '../platform/rendererRegistry'
import { createExtensibleComponent } from './createExtensibleComponent'

describe('createExtensibleComponent', () => {
    let registry: RendererRegistry
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        registry = new RendererRegistry()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        registry.clear()
        rendererRegistry.clear()
        consoleErrorSpy.mockRestore()
    })

    it('sets displayName to Extensible(componentName)', () => {
        const BaseComp: React.FC = () => <div data-testid="base">Base</div>
        const ExtensibleComp = createExtensibleComponent('TestTarget', BaseComp, {
            registry,
        })

        expect(ExtensibleComp.displayName).toBe('Extensible(TestTarget)')
    })

    it('renders BaseComponent directly when no wrappers are registered', () => {
        interface BaseProps {
            title: string
        }

        const BaseComp: React.FC<BaseProps> = ({ title }) => (
            <div data-testid="base-view">{title}</div>
        )

        const ExtensibleComp = createExtensibleComponent<BaseProps>(
            'ChatView',
            BaseComp,
            { registry }
        )

        render(<ExtensibleComp title="Hello CPA" />)

        const baseElement = screen.getByTestId('base-view')
        expect(baseElement).toBeInTheDocument()
        expect(baseElement).toHaveTextContent('Hello CPA')
    })

    it('renders a single wrapper wrapping BaseComponent', () => {
        interface HeaderProps {
            title: string
        }

        const BaseHeader: React.FC<HeaderProps> = ({ title }) => (
            <h1 data-testid="header-title">{title}</h1>
        )

        registry.registerComponentWrapper<HeaderProps>({
            id: 'badge-wrapper',
            pluginId: 'badge-plugin',
            targetComponent: 'Header',
            wrapper: (Inner) => (props) => (
                <div data-testid="header-with-badge" className="flex items-center">
                    <Inner {...props} />
                    <span data-testid="header-badge">VIP</span>
                </div>
            ),
        })

        const ExtensibleHeader = createExtensibleComponent<HeaderProps>(
            'Header',
            BaseHeader,
            { registry }
        )

        render(<ExtensibleHeader title="Dashboard" />)

        expect(screen.getByTestId('header-with-badge')).toBeInTheDocument()
        expect(screen.getByTestId('header-title')).toHaveTextContent('Dashboard')
        expect(screen.getByTestId('header-badge')).toHaveTextContent('VIP')
    })

    it('chains multiple wrappers in correct ascending order', () => {
        const BaseCard: React.FC = () => <div data-testid="base-card">Card Content</div>

        // Outer wrapper (order: 20)
        registry.registerComponentWrapper({
            id: 'outer-border',
            pluginId: 'theme-plugin',
            targetComponent: 'Card',
            order: 20,
            wrapper: (Inner) => (props) => (
                <div data-testid="outer-layer" className="outer">
                    <Inner {...props} />
                </div>
            ),
        })

        // Inner wrapper (order: 10)
        registry.registerComponentWrapper({
            id: 'inner-padding',
            pluginId: 'layout-plugin',
            targetComponent: 'Card',
            order: 10,
            wrapper: (Inner) => (props) => (
                <div data-testid="inner-layer" className="inner">
                    <Inner {...props} />
                </div>
            ),
        })

        const ExtensibleCard = createExtensibleComponent('Card', BaseCard, { registry })

        render(<ExtensibleCard />)

        const outer = screen.getByTestId('outer-layer')
        const inner = screen.getByTestId('inner-layer')
        const base = screen.getByTestId('base-card')

        expect(outer).toBeInTheDocument()
        expect(inner).toBeInTheDocument()
        expect(base).toBeInTheDocument()

        // Order 10 wraps Base first, then Order 20 wraps the result.
        // Therefore, outer-layer contains inner-layer, which contains base-card.
        expect(outer).toContainElement(inner)
        expect(inner).toContainElement(base)
    })

    it('forwards props through all wrapper layers and updates on prop change', () => {
        interface UserProfileProps {
            username: string
            role: string
            count: number
        }

        const UserProfile: React.FC<UserProfileProps> = ({ username, role, count }) => (
            <div data-testid="user-profile">
                <span data-testid="profile-name">{username}</span>
                <span data-testid="profile-role">{role}</span>
                <span data-testid="profile-count">{count}</span>
            </div>
        )

        registry.registerComponentWrapper<UserProfileProps>({
            id: 'logger-wrapper',
            pluginId: 'audit-plugin',
            targetComponent: 'UserProfile',
            order: 10,
            wrapper: (Inner) => (props) => (
                <div data-testid="audit-wrapper">
                    <Inner {...props} />
                </div>
            ),
        })

        registry.registerComponentWrapper<UserProfileProps>({
            id: 'theme-wrapper',
            pluginId: 'ui-plugin',
            targetComponent: 'UserProfile',
            order: 20,
            wrapper: (Inner) => (props) => (
                <div data-testid="ui-theme-wrapper">
                    <Inner {...props} />
                </div>
            ),
        })

        const ExtensibleUserProfile = createExtensibleComponent<UserProfileProps>(
            'UserProfile',
            UserProfile,
            { registry }
        )

        const { rerender } = render(
            <ExtensibleUserProfile username="Alice" role="Admin" count={10} />
        )

        expect(screen.getByTestId('profile-name')).toHaveTextContent('Alice')
        expect(screen.getByTestId('profile-role')).toHaveTextContent('Admin')
        expect(screen.getByTestId('profile-count')).toHaveTextContent('10')

        // Re-render with new props
        rerender(<ExtensibleUserProfile username="Bob" role="Member" count={25} />)

        expect(screen.getByTestId('profile-name')).toHaveTextContent('Bob')
        expect(screen.getByTestId('profile-role')).toHaveTextContent('Member')
        expect(screen.getByTestId('profile-count')).toHaveTextContent('25')
    })

    it('dynamically reacts to wrapper registration and unregistration', () => {
        const BaseBtn: React.FC = () => <button data-testid="action-btn">Action</button>

        const ExtensibleBtn = createExtensibleComponent('ActionBtn', BaseBtn, { registry })

        render(<ExtensibleBtn />)
        expect(screen.getByTestId('action-btn')).toBeInTheDocument()
        expect(screen.queryByTestId('btn-enhancer')).not.toBeInTheDocument()

        // Dynamically register wrapper
        let unregister: () => void = () => {}
        act(() => {
            unregister = registry.registerComponentWrapper({
                id: 'btn-enhancer-id',
                pluginId: 'enhancer-plugin',
                targetComponent: 'ActionBtn',
                wrapper: (Inner) => (props) => (
                    <div data-testid="btn-enhancer">
                        <Inner {...props} />
                        <span data-testid="enhancer-tag">Enhanced</span>
                    </div>
                ),
            })
        })

        expect(screen.getByTestId('btn-enhancer')).toBeInTheDocument()
        expect(screen.getByTestId('enhancer-tag')).toHaveTextContent('Enhanced')
        expect(screen.getByTestId('action-btn')).toBeInTheDocument()

        // Dynamically unregister wrapper
        act(() => {
            unregister()
        })

        expect(screen.queryByTestId('btn-enhancer')).not.toBeInTheDocument()
        expect(screen.getByTestId('action-btn')).toBeInTheDocument()
    })

    it('isolates crashing wrapper with SlotErrorBoundary and renders BaseComponent fallback', () => {
        interface EditorProps {
            content: string
        }

        const BaseEditor: React.FC<EditorProps> = ({ content }) => (
            <div data-testid="base-editor">{content}</div>
        )

        const BrokenWrapper: React.FC<EditorProps> = () => {
            throw new Error('Wrapper failed to render')
        }

        registry.registerComponentWrapper<EditorProps>({
            id: 'broken-wrapper',
            pluginId: 'bad-plugin',
            targetComponent: 'Editor',
            wrapper: () => BrokenWrapper,
        })

        const ExtensibleEditor = createExtensibleComponent<EditorProps>(
            'Editor',
            BaseEditor,
            { registry }
        )

        render(<ExtensibleEditor content="Hello Safe World" />)

        // The broken wrapper fails, but SlotErrorBoundary catches the error and falls back to BaseEditor
        expect(screen.getByTestId('base-editor')).toBeInTheDocument()
        expect(screen.getByTestId('base-editor')).toHaveTextContent('Hello Safe World')
        expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('falls back to inner wrapper when outer wrapper throws during render', () => {
        const BaseView: React.FC = () => <div data-testid="view-base">View Content</div>

        // Inner healthy wrapper (order: 10)
        registry.registerComponentWrapper({
            id: 'inner-good',
            pluginId: 'good-plugin',
            targetComponent: 'View',
            order: 10,
            wrapper: (Inner) => (props) => (
                <div data-testid="inner-good-wrapper">
                    <Inner {...props} />
                </div>
            ),
        })

        // Outer broken wrapper (order: 20)
        registry.registerComponentWrapper({
            id: 'outer-broken',
            pluginId: 'broken-plugin',
            targetComponent: 'View',
            order: 20,
            wrapper: () => () => {
                throw new Error('Outer wrapper crashed!')
            },
        })

        const ExtensibleView = createExtensibleComponent('View', BaseView, { registry })

        render(<ExtensibleView />)

        // Outer wrapper crashed, falls back to inner wrapper + base component
        expect(screen.getByTestId('inner-good-wrapper')).toBeInTheDocument()
        expect(screen.getByTestId('view-base')).toBeInTheDocument()
        expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('gracefully falls back when wrapper factory throws an error during composition', () => {
        const BaseComp: React.FC = () => <div data-testid="base-comp">Base Content</div>

        registry.registerComponentWrapper({
            id: 'broken-factory-wrapper',
            pluginId: 'broken-plugin',
            targetComponent: 'Comp',
            wrapper: () => {
                throw new Error('Factory composition failure')
            },
        })

        const ExtensibleComp = createExtensibleComponent('Comp', BaseComp, { registry })

        render(<ExtensibleComp />)

        expect(screen.getByTestId('base-comp')).toBeInTheDocument()
        expect(screen.getByTestId('base-comp')).toHaveTextContent('Base Content')
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            '[createExtensibleComponent] Wrapper "broken-factory-wrapper" failed to compose:',
            expect.any(Error)
        )
    })

    it('still renders outer wrapper when inner wrapper throws during render', () => {
        const BaseView: React.FC = () => <div data-testid="view-base">View Content</div>

        // Inner broken wrapper (order: 10)
        registry.registerComponentWrapper({
            id: 'inner-broken',
            pluginId: 'broken-plugin',
            targetComponent: 'View',
            order: 10,
            wrapper: () => () => {
                throw new Error('Inner wrapper crashed!')
            },
        })

        // Outer healthy wrapper (order: 20)
        registry.registerComponentWrapper({
            id: 'outer-healthy',
            pluginId: 'healthy-plugin',
            targetComponent: 'View',
            order: 20,
            wrapper: (Inner) => (props) => (
                <div data-testid="outer-healthy-wrapper">
                    <span data-testid="outer-badge">Outer</span>
                    <Inner {...props} />
                </div>
            ),
        })

        const ExtensibleView = createExtensibleComponent('View', BaseView, { registry })

        render(<ExtensibleView />)

        // Outer wrapper still renders successfully
        expect(screen.getByTestId('outer-healthy-wrapper')).toBeInTheDocument()
        expect(screen.getByTestId('outer-badge')).toBeInTheDocument()
        // Inner wrapper crashed and fell back to BaseView
        expect(screen.getByTestId('view-base')).toBeInTheDocument()
        expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('uses defaultExtensionRegistry when no registry option is specified', () => {
        const BaseItem: React.FC = () => <div data-testid="default-item">Default Item</div>

        rendererRegistry.registerComponentWrapper({
            id: 'default-reg-wrapper',
            pluginId: 'default-plugin',
            targetComponent: 'DefaultTarget',
            wrapper: (Inner) => (props) => (
                <div data-testid="default-reg-wrapper-view">
                    <Inner {...props} />
                </div>
            ),
        })

        const ExtensibleDefault = createExtensibleComponent('DefaultTarget', BaseItem)

        render(<ExtensibleDefault />)

        expect(screen.getByTestId('default-reg-wrapper-view')).toBeInTheDocument()
        expect(screen.getByTestId('default-item')).toBeInTheDocument()
    })
})
