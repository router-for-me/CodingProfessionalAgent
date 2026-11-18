export const MAX_TITLE_PREVIEW_LENGTH = 40
export const MAX_QUESTION_PREVIEW_LENGTH = 80
export const MAX_DATA_SESSION_TITLE_LENGTH = 256
export const MAX_APNS_COLLAPSE_ID_BYTES = 64

export function formatTitlePreview(sessionTitle?: string): string {
    const rawTitle = (typeof sessionTitle === 'string' ? sessionTitle : '').trim()
    if (!rawTitle) {
        return ''
    }
    return rawTitle.length > MAX_TITLE_PREVIEW_LENGTH
        ? `${rawTitle.slice(0, MAX_TITLE_PREVIEW_LENGTH)}...`
        : rawTitle
}

export function formatQuestionPreview(question?: string): string {
    const collapsed = (typeof question === 'string' ? question : '')
        .replace(/\s+/g, ' ')
        .trim()
    if (!collapsed) {
        return ''
    }
    return collapsed.length > MAX_QUESTION_PREVIEW_LENGTH
        ? `${collapsed.slice(0, MAX_QUESTION_PREVIEW_LENGTH)}...`
        : collapsed
}

export function formatTaskCompletedNotificationBody(sessionTitle?: string): string {
    const title = formatTitlePreview(sessionTitle)
    return title ? `${title} 任务已经完成` : '任务已经完成'
}

export function formatAskRequestedNotificationBody(
    sessionTitle?: string,
    question?: string,
): string {
    const title = formatTitlePreview(sessionTitle)
    const questionPreview = formatQuestionPreview(question)
    if (title && questionPreview) {
        return `${title} 正在询问：${questionPreview}`
    }
    if (title) {
        return `${title} 等待你的回答`
    }
    if (questionPreview) {
        return `正在询问：${questionPreview}`
    }
    return '等待你的回答'
}

export function truncateSessionTitleForData(sessionTitle?: string): string | undefined {
    const rawTitle = (typeof sessionTitle === 'string' ? sessionTitle : '').trim()
    if (!rawTitle) {
        return undefined
    }
    return rawTitle.length > MAX_DATA_SESSION_TITLE_LENGTH
        ? `${rawTitle.slice(0, MAX_DATA_SESSION_TITLE_LENGTH)}...`
        : rawTitle
}

export function sliceUtf8Bytes(value: string, maxBytes: number): string {
    if (!value || maxBytes <= 0) {
        return ''
    }
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
        return value
    }
    let result = ''
    let usedBytes = 0
    for (const ch of value) {
        const chBytes = Buffer.byteLength(ch, 'utf8')
        if (usedBytes + chBytes > maxBytes) {
            break
        }
        result += ch
        usedBytes += chBytes
    }
    return result
}
