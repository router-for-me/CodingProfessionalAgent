import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from './projectStore'

beforeEach(() => {
    useProjectStore.setState({ projects: [] })
})

describe('projectStore', () => {
    it('stores all source folders and keeps the first as the primary path', () => {
        const id = useProjectStore.getState().addProject({
            name: 'Workspace',
            paths: ['/repo', '/shared', '/repo', ''],
        })

        expect(useProjectStore.getState().projects[0]).toMatchObject({
            id,
            path: '/repo',
            paths: ['/repo', '/shared'],
        })
    })
})
