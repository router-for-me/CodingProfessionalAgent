export function parseLegacyMemoryFilename(filename: string): { title: string; createdAt?: number } {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.md$/.exec(filename)
    if (!match) {
        return { title: filename.replace(/\.md$/, ''), createdAt: undefined }
    }
    const [, year, month, day, hour, minute, second, title] = match
    const createdAt = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime()
    return { title, createdAt }
}
