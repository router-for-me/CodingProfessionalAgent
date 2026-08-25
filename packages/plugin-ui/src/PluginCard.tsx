import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from './cn.js'

export interface PluginCardProps extends ComponentPropsWithoutRef<'div'> {
    variant?: 'default' | 'elevated' | 'subtle'
    children?: ReactNode
}

export function PluginCard({
    variant = 'default',
    className,
    children,
    ...props
}: PluginCardProps) {
    return (
        <div
            className={cn(
                'rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5',
                variant === 'elevated' && 'bg-[var(--bg-elevated)] shadow-xs',
                variant === 'subtle' && 'bg-[var(--bg-app)]',
                className,
            )}
            {...props}
        >
            {children}
        </div>
    )
}

export interface PluginCardHeaderProps extends ComponentPropsWithoutRef<'div'> {
    children?: ReactNode
}

export function PluginCardHeader({
    className,
    children,
    ...props
}: PluginCardHeaderProps) {
    return (
        <div
            className={cn('flex items-center justify-between gap-2', className)}
            {...props}
        >
            {children}
        </div>
    )
}

export interface PluginCardTitleProps extends ComponentPropsWithoutRef<'div'> {
    children?: ReactNode
}

export function PluginCardTitle({
    className,
    children,
    ...props
}: PluginCardTitleProps) {
    return (
        <div
            className={cn(
                'flex items-center gap-2 font-mono text-xs font-semibold text-[var(--text-primary)]',
                className,
            )}
            {...props}
        >
            {children}
        </div>
    )
}

export interface PluginCardBodyProps extends ComponentPropsWithoutRef<'div'> {
    children?: ReactNode
}

export function PluginCardBody({
    className,
    children,
    ...props
}: PluginCardBodyProps) {
    return (
        <div
            className={cn('mt-2 text-xs leading-relaxed text-[var(--text-secondary)]', className)}
            {...props}
        >
            {children}
        </div>
    )
}

export interface PluginCardFooterProps extends ComponentPropsWithoutRef<'div'> {
    children?: ReactNode
}

export function PluginCardFooter({
    className,
    children,
    ...props
}: PluginCardFooterProps) {
    return (
        <div
            className={cn('mt-2.5 flex items-center justify-end gap-2', className)}
            {...props}
        >
            {children}
        </div>
    )
}

export interface PluginCardBadgeProps extends ComponentPropsWithoutRef<'span'> {
    children?: ReactNode
}

export function PluginCardBadge({
    className,
    children,
    ...props
}: PluginCardBadgeProps) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--text-muted)]',
                className,
            )}
            {...props}
        >
            {children}
        </span>
    )
}
