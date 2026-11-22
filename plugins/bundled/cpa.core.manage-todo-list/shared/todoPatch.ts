import type { TodoAddInput, TodoChangeRecord, TodoItem, TodoStatus, TodoUpdateArguments, TodoUpdatePatch } from './types.js'

export const AUTO_CLEAR_DELAY_MS = 4000

type TodoFields = Omit<TodoUpdatePatch, 'id'>

export function isValidTodoStatus(value: unknown): value is TodoStatus {
    return value === 'not-started' || value === 'in-progress' || value === 'completed'
}

export function validateTodoList(rawList: readonly unknown[]): TodoItem[] {
    const todos: TodoItem[] = []
    for (let index = 0; index < rawList.length; index++) {
        const item = rawList[index]
        if (!item || typeof item !== 'object') continue
        const raw = item as Record<string, unknown>
        const id = typeof raw.id === 'number' ? raw.id : index + 1
        const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Task ${id}`
        const description = typeof raw.description === 'string' ? raw.description : ''
        const status = String(raw.status ?? '').toLowerCase()
        todos.push({ id, title, description, status: isValidTodoStatus(status) ? status : 'not-started' })
    }
    return todos
}

function isPositiveTodoId(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonEmptyTitle(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

export function validateTodoSnapshot(raw: unknown): TodoItem[] | null {
    const list = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object'
            ? (raw as Record<string, unknown>).todoSnapshot
            : null
    if (!Array.isArray(list)) return null

    const todos: TodoItem[] = []
    for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null
        const { id, title, description, status } = item as Record<string, unknown>
        if (!isPositiveTodoId(id) || !isNonEmptyTitle(title) || typeof description !== 'string' || !isValidTodoStatus(status)) {
            return null
        }
        todos.push({ id, title, description, status })
    }
    return todos
}

function readArray(args: Record<string, unknown>, field: string): readonly unknown[] {
    const value = args[field]
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`"${field}" must be an array.`)
    return value
}

function validateTodoFields({ status, title, description }: Record<string, unknown>, label: string): TodoFields {
    const fields: TodoFields = {}
    if (status !== undefined) {
        if (!isValidTodoStatus(status)) {
            throw new Error(`${label} status must be "not-started", "in-progress", or "completed".`)
        }
        fields.status = status
    }
    if (title !== undefined) {
        if (!isNonEmptyTitle(title)) throw new Error(`${label} title must be a non-empty string.`)
        fields.title = title.trim()
    }
    if (description !== undefined) {
        if (typeof description !== 'string') throw new Error(`${label} description must be a string.`)
        fields.description = description
    }
    return fields
}

export function applyTodoUpdate(
    current: readonly TodoItem[],
    args: Record<string, unknown>,
): { nextTodos: TodoItem[]; changes: TodoChangeRecord[]; normalizedPatch: TodoUpdateArguments } {
    const updates = readArray(args, 'updates')
    const add = readArray(args, 'add')
    const removeIds = readArray(args, 'removeIds')
    if (updates.length === 0 && add.length === 0 && removeIds.length === 0) {
        throw new Error('At least one of "updates", "add", or "removeIds" must be non-empty.')
    }

    const patches = new Map<number, TodoFields>()
    for (const item of updates) {
        if (!isPlainObject(item) || !isPositiveTodoId(item.id)) {
            throw new Error('Each "updates" entry must be a plain object with a positive integer id.')
        }
        const { id } = item
        if (patches.has(id)) throw new Error(`Duplicate ID #${id} in "updates".`)
        const fields = validateTodoFields(item, `Update for #${id}:`)
        if (Object.keys(fields).length === 0) {
            throw new Error(`Update for #${id} must include status, title, or description.`)
        }
        patches.set(id, fields)
    }

    const removed = new Set<number>()
    for (const id of removeIds) {
        if (!isPositiveTodoId(id)) throw new Error('Each "removeIds" entry must be a positive integer.')
        if (removed.has(id)) throw new Error(`Duplicate ID #${id} in "removeIds".`)
        if (patches.has(id)) throw new Error(`Cannot update and remove ID #${id} in the same call.`)
        removed.add(id)
    }

    const occurrences = new Map<number, number>()
    for (const { id } of current) occurrences.set(id, (occurrences.get(id) ?? 0) + 1)
    const targets = [...patches.keys(), ...removed]
    const ambiguous = targets.filter((id) => (occurrences.get(id) ?? 0) > 1)
    if (ambiguous.length > 0) {
        const ids = ambiguous.map((id) => `#${id}`).join(', ')
        throw new Error(`Ambiguous duplicate todo IDs in current list: ${ids}. Call operation: "write" to rebuild the list with unique IDs.`)
    }
    const currentIds = new Set(occurrences.keys())
    const missing = targets.filter((id) => !currentIds.has(id))
    if (missing.length > 0) {
        const guidance = current.length === 0
            ? 'The todo list is currently empty (or all previous tasks were completed). Call operation: "write" to create a new list, or operation: "update" with add.'
            : `Available IDs: ${[...currentIds].join(', ')}. Call operation: "read" to inspect current items.`
        throw new Error(`Todo IDs not found: ${missing.map((id) => `#${id}`).join(', ')}. ${guidance}`)
    }

    let maxId = 0
    for (const id of currentIds) {
        if (id > maxId) maxId = id
    }
    const occupiedIds = new Set([...currentIds].filter((id) => !removed.has(id)))
    const added: TodoItem[] = []
    const normalizedAdds: TodoAddInput[] = []
    for (const item of add) {
        if (!isPlainObject(item)) throw new Error('Each "add" entry must be a plain object.')
        const { title, status, description } = validateTodoFields(item, 'Add entry:')
        if (title === undefined) throw new Error('Add entry: title must be a non-empty string.')
        const id = item.id === undefined ? maxId + 1 : item.id
        if (!isPositiveTodoId(id)) throw new Error('Add entry: id must be a positive integer.')
        if (item.id === undefined && id <= maxId) throw new Error('Cannot allocate the next todo ID.')
        if (occupiedIds.has(id)) throw new Error(`Add entry: ID #${id} already exists.`)
        added.push({ id, title, description: description ?? '', status: status ?? 'not-started' })
        normalizedAdds.push({
            title,
            ...(description !== undefined ? { description } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(item.id !== undefined ? { id } : {}),
        })
        occupiedIds.add(id)
        maxId = Math.max(maxId, id)
    }

    const nextTodos = current
        .filter(({ id }) => !removed.has(id))
        .map((item) => ({ ...item, ...patches.get(item.id) }))
    const changes: TodoChangeRecord[] = []
    for (const [id, { status, title, description }] of patches) {
        changes.push({
            kind: 'update',
            id,
            fields: {
                ...(status !== undefined && { status }),
                ...(title !== undefined && { title }),
                ...(description !== undefined && { descriptionChanged: true }),
            },
        })
    }
    for (const id of removed) changes.push({ kind: 'remove', id })
    for (const { id, title, status } of added) changes.push({ kind: 'add', id, title, status })
    const normalizedPatch: TodoUpdateArguments = { operation: 'update' }
    if (patches.size) normalizedPatch.updates = Array.from(patches, ([id, fields]) => ({ id, ...fields }))
    if (normalizedAdds.length) normalizedPatch.add = normalizedAdds
    if (removed.size) normalizedPatch.removeIds = [...removed]
    return { nextTodos: nextTodos.concat(added), changes, normalizedPatch }
}

export function tryApplyTodoUpdate(current: readonly TodoItem[], args: Record<string, unknown>): TodoItem[] | null {
    try {
        return applyTodoUpdate(current, args).nextTodos
    } catch {
        return null
    }
}

export function formatTodoUpdateOutput(nextTodos: readonly TodoItem[], changes: readonly TodoChangeRecord[]): string {
    const completed = nextTodos.filter(({ status }) => status === 'completed').length
    const inProgress = nextTodos.filter(({ status }) => status === 'in-progress').length
    const summary = nextTodos.length === 0
        ? '0 items remaining'
        : `${completed}/${nextTodos.length} completed${inProgress > 0 ? `, ${inProgress} in-progress` : ''}`
    const lines = [`Updated todo list (${summary}):`]
    for (const change of changes) {
        if (change.kind === 'add') {
            lines.push(`+ #${change.id}: ${change.title} (${change.status})`)
        } else if (change.kind === 'remove') {
            lines.push(`- #${change.id}: removed`)
        } else {
            const { status, title, descriptionChanged } = change.fields
            const parts: string[] = []
            if (status !== undefined) parts.push(`status -> ${status}`)
            if (title !== undefined) parts.push(`title -> ${JSON.stringify(title)}`)
            if (descriptionChanged) parts.push('description updated')
            lines.push(`~ #${change.id}: ${parts.join(', ')}`)
        }
    }
    return lines.join('\n')
}
