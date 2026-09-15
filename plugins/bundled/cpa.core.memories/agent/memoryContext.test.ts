import { describe, expect, it } from 'vitest'
import {
    buildMemoryReadPathInstructions,
    loadMemoryReadPathContext,
} from './memoryContext.js'
import { stringToBase64 } from './localMemoriesBackend.js'

class MockBridge {
    files = new Map<string, string>()

    async runtimeInfo() {
        return {
            homeDir: '/mock/home',
            platform: 'darwin',
        }
    }

    async readFile(path: string) {
        if (!this.files.has(path)) {
            throw new Error(`File not found: ${path}`)
        }
        return new TextEncoder().encode(this.files.get(path)!)
    }

    async ReadFile(path: string) {
        if (!this.files.has(path)) {
            throw new Error(`File not found: ${path}`)
        }
        return { dataBase64: stringToBase64(this.files.get(path)!) }
    }
}

describe('buildMemoryReadPathInstructions', () => {
    it('renders full read path memory instructions with normalized paths and summary markers', () => {
        const basePath = '/Users/test/.coding-professional-agent/memories'
        const summary = 'User prefers TypeScript and dark theme.'

        const instructions = buildMemoryReadPathInstructions(basePath, summary)

        expect(instructions).toContain('## Memory')
        expect(instructions).toContain('Decision boundary: should you use memory for a new user query?')
        expect(instructions).toContain('Memory layout (general -> specific):')
        expect(instructions).toContain(`${basePath}/memory_summary.md (already provided below; do NOT open again)`)
        expect(instructions).toContain(`${basePath}/MEMORY.md (searchable registry; primary file to query)`)
        expect(instructions).toContain(`${basePath}/skills/<skill-name>/`)
        expect(instructions).toContain(`${basePath}/rollout_summaries/`)
        expect(instructions).toContain('Quick memory pass (when applicable):')
        expect(instructions).toContain('1. Skim the MEMORY_SUMMARY below and extract task-relevant keywords.')
        expect(instructions).toContain('Quick-pass budget:')
        expect(instructions).toContain('ideally <= 4-6 search steps before main work.')
        expect(instructions).toContain('During execution: if you hit repeated errors, confusing behavior')
        expect(instructions).toContain('How to decide whether to verify memory:')
        expect(instructions).toContain('When answering from memory without current verification:')
        expect(instructions).toContain('Memory citation requirements:')
        expect(instructions).toContain('<oai-mem-citation>')
        expect(instructions).toContain('<citation_entries>')
        expect(instructions).toContain('MEMORY.md:234-236|note=[responsesapi citation extraction code pointer]')
        expect(instructions).toContain('rollout_summaries/2026-02-17T21-23-02-LN3m-example.md:10-12|note=[weekly report format]')
        expect(instructions).toContain('<rollout_ids>')
        expect(instructions).toContain('019c6e27-e55b-73d1-87d8-4e01f1f75043')
        expect(instructions).toContain('019c7714-3b77-74d1-9866-e1f484aae2ab')
        expect(instructions).toContain('Never include memory citations inside pull-request messages.')
        expect(instructions).toContain('Never cite blank lines; double-check ranges.')
        expect(instructions).toContain('Updating memories:')
        expect(instructions).toContain(`${basePath}/extensions/ad_hoc/notes/`)
        expect(instructions).toContain('<timestamp>-<short slug>.md')
        expect(instructions).toContain('========= MEMORY_SUMMARY BEGINS =========\nUser prefers TypeScript and dark theme.\n========= MEMORY_SUMMARY ENDS =========')
        expect(instructions).toContain('When memory is likely relevant, start with the quick memory pass above before\ndeep repo exploration.')
    })

    it('normalizes backslashes and trailing slashes in basePath', () => {
        const windowsPath = 'C:\\Users\\test\\.coding-professional-agent\\memories\\'
        const summary = 'Test summary'

        const instructions = buildMemoryReadPathInstructions(windowsPath, summary)

        expect(instructions).toContain('C:/Users/test/.coding-professional-agent/memories/memory_summary.md')
        expect(instructions).toContain('C:/Users/test/.coding-professional-agent/memories/MEMORY.md')
    })
})

describe('loadMemoryReadPathContext', () => {
    it('returns null when localMemoryEnabled is explicitly false', async () => {
        const bridge = new MockBridge()
        bridge.files.set(
            '/home/test/.coding-professional-agent/memories/memory_summary.md',
            'Some memory content',
        )

        const result = await loadMemoryReadPathContext({
            homeDir: '/home/test',
            bridge,
            localMemoryEnabled: false,
        })

        expect(result).toBeNull()
    })

    it('returns null when bridge is unavailable', async () => {
        const result = await loadMemoryReadPathContext({
            homeDir: '/home/test',
            bridge: undefined,
            localMemoryEnabled: true,
        })

        expect(result).toBeNull()
    })

    it('generates memory instructions when memory_summary.md does not exist', async () => {
        const bridge = new MockBridge()
        const result = await loadMemoryReadPathContext({
            homeDir: '/home/test',
            bridge,
            localMemoryEnabled: true,
        })

        expect(result).not.toBeNull()
        expect(result).toContain('## Memory')
        expect(result).toContain('Task initiation: retrieve user memories at the start of every task')
        expect(result).toContain('Task completion: synthesize completed tasks and record user preferences')
        expect(result).toContain('Specially prioritize User Preferences')
        expect(result).toContain('No prior memory summary recorded yet.')
    })

    it('generates memory instructions when memory_summary.md is whitespace only', async () => {
        const bridge = new MockBridge()
        bridge.files.set(
            '/home/test/.coding-professional-agent/memories/memory_summary.md',
            '   \n\t  ',
        )

        const result = await loadMemoryReadPathContext({
            homeDir: '/home/test',
            bridge,
            localMemoryEnabled: true,
        })

        expect(result).not.toBeNull()
        expect(result).toContain('## Memory')
        expect(result).toContain('No prior memory summary recorded yet.')
    })

    it('loads and generates instructions from memory_summary.md using homeDir', async () => {
        const bridge = new MockBridge()
        const homeDir = '/mock/home'
        bridge.files.set(
            `${homeDir}/.coding-professional-agent/memories/memory_summary.md`,
            'User prefers dark mode and concise responses.',
        )

        const result = await loadMemoryReadPathContext({
            homeDir,
            bridge,
            localMemoryEnabled: true,
        })

        expect(result).not.toBeNull()
        expect(result).toContain('## Memory')
        expect(result).toContain('User prefers dark mode and concise responses.')
        expect(result).toContain(`${homeDir}/.coding-professional-agent/memories/memory_summary.md`)
    })

    it('loads and generates instructions using custom memoryRoot', async () => {
        const bridge = new MockBridge()
        const customRoot = '/custom/memories/root'
        bridge.files.set(
            `${customRoot}/memory_summary.md`,
            'Project-specific summary.',
        )

        const result = await loadMemoryReadPathContext({
            memoryRoot: customRoot,
            bridge,
            localMemoryEnabled: true,
        })

        expect(result).not.toBeNull()
        expect(result).toContain('## Memory')
        expect(result).toContain('Project-specific summary.')
        expect(result).toContain(`${customRoot}/memory_summary.md`)
    })

    it('truncates oversized memory_summary.md according to token budget', async () => {
        const bridge = new MockBridge()
        const homeDir = '/mock/home'
        const longSummary = 'Line of memory summary info.\n'.repeat(1000)

        bridge.files.set(
            `${homeDir}/.coding-professional-agent/memories/memory_summary.md`,
            longSummary,
        )

        const result = await loadMemoryReadPathContext({
            homeDir,
            bridge,
            localMemoryEnabled: true,
        })

        expect(result).not.toBeNull()
        expect(result).toContain('## Memory')
        expect(result).toContain('tokens truncated')
    })

    it('injects instructions with task initiation retrieval, task completion synthesis, and user preference persistence', async () => {
        const instructions = buildMemoryReadPathInstructions('/test/memories', '')

        expect(instructions).toContain('Task initiation: retrieve user memories at the start of every task')
        expect(instructions).toContain('memories_search')
        expect(instructions).toContain('Task completion: synthesize completed tasks and record user preferences')
        expect(instructions).toContain('Specially prioritize User Preferences')
        expect(instructions).toContain('memories_add_ad_hoc_note')
        expect(instructions).toContain('YYYY-MM-DDTHH-MM-SS-<slug>.md')
        expect(instructions).not.toContain('You can update the memories only when explicitly asked by the user')
    })
})
