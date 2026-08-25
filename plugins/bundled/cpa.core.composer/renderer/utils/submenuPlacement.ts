export type SubmenuSide = 'left' | 'right'

export interface SubmenuPlacement {
    side: SubmenuSide
    left: number
    top: number
    width: number
    maxHeight: number
}

export function resolveSubmenuSide(
    anchor: Pick<DOMRect, 'left' | 'right'>,
    submenuWidth: number,
    viewportWidth: number,
    gutter = 8,
): SubmenuSide {
    return anchor.right + gutter + submenuWidth <= viewportWidth ? 'right' : 'left'
}

export function resolveSubmenuPlacement(
    anchor: Pick<DOMRect, 'left' | 'right' | 'bottom'>,
    submenu: Pick<DOMRect, 'width' | 'height'>,
    viewport: Pick<Window, 'innerWidth' | 'innerHeight'>,
    gutter = 8,
): SubmenuPlacement {
    const availableWidth = Math.max(0, viewport.innerWidth - gutter * 2)
    const width = Math.min(Math.max(submenu.width, 0), availableWidth)
    const maxHeight = Math.max(0, viewport.innerHeight - gutter * 2)
    const height = Math.min(Math.max(submenu.height, 0), maxHeight)
    const side = resolveSubmenuSide(anchor, width, viewport.innerWidth, gutter)
    const preferredLeft =
        side === 'right'
            ? anchor.right + gutter
            : anchor.left - gutter - width
    const maxLeft = Math.max(gutter, viewport.innerWidth - gutter - width)
    const left = Math.min(Math.max(preferredLeft, gutter), maxLeft)
    const maxTop = Math.max(gutter, viewport.innerHeight - gutter - height)
    const top = Math.min(Math.max(anchor.bottom - height, gutter), maxTop)

    return { side, left, top, width, maxHeight }
}
