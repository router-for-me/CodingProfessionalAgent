import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn, useTranslation, X } from '@cpa/plugin-ui'
import type { DisplayMessageImage } from '../types.js'

/** Image formats the composer sends to the model; anything else is not rendered. */
const PREVIEWABLE_IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp)$/i

/** Keeps the images of a user prompt that can be shown as `data:` URLs (bare base64 data). */
export function previewableUserImages(images: unknown): DisplayMessageImage[] {
    if (!Array.isArray(images)) return []
    return images.filter(
        (image): image is DisplayMessageImage =>
            Boolean(image) &&
            typeof image.data === 'string' &&
            image.data.length > 0 &&
            !image.data.startsWith('data:') &&
            typeof image.mimeType === 'string' &&
            PREVIEWABLE_IMAGE_MIME.test(image.mimeType),
    )
}

function toImageSrc(image: DisplayMessageImage): string {
    return `data:${image.mimeType};base64,${image.data}`
}

/** Projections recreate the image objects; the (immutable) base64 data decides whether they changed. */
function sameImages(
    previous: readonly DisplayMessageImage[],
    next: readonly DisplayMessageImage[],
): boolean {
    if (previous === next) return true
    if (previous.length !== next.length) return false
    return previous.every(
        (image, index) =>
            image.mimeType === next[index]?.mimeType && image.data === next[index]?.data,
    )
}

/**
 * Thumbnails of the images sent with a user prompt. A single image keeps its aspect ratio;
 * several images are shown as square tiles. Clicking a thumbnail opens a full-size preview.
 */
export const UserMessageImages = memo(
    function UserMessageImages(props: {
        images: readonly DisplayMessageImage[]
        className?: string
    }) {
        const { images, className } = props
        const { t } = useTranslation()
        const [previewIndex, setPreviewIndex] = useState<number | null>(null)
        // Built once per image set, so re-renders do not copy the base64 data again.
        const sources = useMemo(() => images.map(toImageSrc), [images])
        const single = images.length === 1
        const previewSource = previewIndex === null ? undefined : sources[previewIndex]
        const imageAlt = (index: number) =>
            t('message.imageAlt', { index: index + 1, defaultValue: `Image ${index + 1}` })

        return (
            <>
                <div
                    className={cn('flex max-w-full flex-wrap justify-end gap-2', className)}
                    data-testid="user-message-images"
                >
                    {sources.map((source, index) => (
                        <button
                            key={index}
                            type="button"
                            title={t('message.previewImage', { defaultValue: 'View image' })}
                            aria-label={t('message.previewImage', { defaultValue: 'View image' })}
                            onClick={() => setPreviewIndex(index)}
                            className={cn(
                                'block max-w-full shrink-0 cursor-zoom-in overflow-hidden rounded-[var(--radius-card)]',
                                'border border-[var(--border-subtle)] bg-[var(--bg-card)]',
                                'transition-opacity hover:opacity-90',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                            )}
                            data-testid="user-message-image"
                        >
                            <img
                                src={source}
                                alt={imageAlt(index)}
                                draggable={false}
                                className={cn(
                                    'block select-none',
                                    single
                                        ? 'max-h-64 max-w-full object-contain'
                                        : 'size-28 object-cover object-center',
                                )}
                            />
                        </button>
                    ))}
                </div>
                {previewSource !== undefined && previewIndex !== null ? (
                    <ImagePreviewOverlay
                        src={previewSource}
                        alt={imageAlt(previewIndex)}
                        onClose={() => setPreviewIndex(null)}
                    />
                ) : null}
            </>
        )
    },
    (previous, next) =>
        previous.className === next.className && sameImages(previous.images, next.images),
)

/**
 * Full-size image above all other UI. Focus stays on its close button while it is open;
 * it closes on Escape, the close button or a backdrop click.
 */
function ImagePreviewOverlay(props: { src: string; alt: string; onClose: () => void }) {
    const { src, alt, onClose } = props
    const { t } = useTranslation()
    const closeButtonRef = useRef<HTMLButtonElement>(null)
    const onCloseRef = useRef(onClose)

    useEffect(() => {
        onCloseRef.current = onClose
    })

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        closeButtonRef.current?.focus()
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Tab') {
                // The close button is the only control, so Tab must not reach the UI behind the preview.
                event.preventDefault()
                closeButtonRef.current?.focus()
                return
            }
            if (event.key !== 'Escape') return
            // Escape must only close the preview, not reach other shortcuts.
            event.preventDefault()
            event.stopPropagation()
            onCloseRef.current()
        }
        window.addEventListener('keydown', handleKeyDown, true)
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true)
            previousFocus?.focus()
        }
    }, [])

    if (typeof document === 'undefined') return null

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-10 backdrop-blur-xs"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose()
            }}
            data-testid="user-image-preview"
        >
            <img
                src={src}
                alt={alt}
                draggable={false}
                className="max-h-full max-w-full rounded-[var(--radius-card)] object-contain shadow-2xl select-none"
            />
            <button
                ref={closeButtonRef}
                type="button"
                title={t('message.closeImagePreview', { defaultValue: 'Close preview' })}
                aria-label={t('message.closeImagePreview', { defaultValue: 'Close preview' })}
                onClick={onClose}
                className={cn(
                    'absolute top-4 right-4 flex size-8 items-center justify-center rounded-full cursor-pointer',
                    'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-sm',
                    'transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                )}
            >
                <X className="size-4" />
            </button>
        </div>,
        document.body,
    )
}
