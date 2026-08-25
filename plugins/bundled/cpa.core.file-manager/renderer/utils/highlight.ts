import { hljs } from '@cpa/plugin-ui'

/** Helper to decode base64 string to UTF-8. */
export function base64ToUtf8(b64: string): string {
    if (!b64) return ''
    try {
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i)
        }
        return new TextDecoder().decode(bytes)
    } catch {
        return ''
    }
}

export const EXT_TO_LANGUAGE: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    go: 'go',
    py: 'python',
    pyw: 'python',
    rs: 'rust',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    jsonc: 'json',
    toml: 'toml',
    xml: 'xml',
    svg: 'xml',
    html: 'xml',
    htm: 'xml',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    psm1: 'powershell',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    sql: 'sql',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    lua: 'lua',
    r: 'r',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    dart: 'dart',
    scala: 'scala',
    hs: 'haskell',
    diff: 'diff',
    patch: 'diff',
    dockerfile: 'dockerfile',
    ini: 'ini',
    conf: 'ini',
    env: 'ini',
    properties: 'properties',
    makefile: 'makefile',
    graphql: 'graphql',
    proto: 'protobuf',
}

export const SPECIAL_FILES_MAP: Record<string, string> = {
    Dockerfile: 'dockerfile',
    'docker-compose.yml': 'yaml',
    'docker-compose.yaml': 'yaml',
    Makefile: 'makefile',
    'go.mod': 'go',
    'go.sum': 'go',
    '.gitignore': 'ini',
    '.dockerignore': 'ini',
    '.npmrc': 'ini',
    '.editorconfig': 'ini',
    'package.json': 'json',
    'tsconfig.json': 'json',
}

/** Split highlighted HTML by lines while properly balancing tags on every line. */
export function splitHtmlIntoLines(html: string): string[] {
    const lines: string[] = []
    const openTags: string[] = []
    const rawLines = html.split('\n')

    for (let i = 0; i < rawLines.length; i += 1) {
        const line = rawLines[i]
        const lineWithOpenTags = openTags.join('') + line

        let m: RegExpExecArray | null
        const re = /<(\/)?([a-zA-Z0-9_\-]+)(?:\s+[^>]*)?>/g
        while ((m = re.exec(line)) !== null) {
            const isClosing = m[1] === '/'
            const fullTag = m[0]
            if (isClosing) {
                openTags.pop()
            } else {
                openTags.push(fullTag)
            }
        }

        let closingTags = ''
        for (let j = openTags.length - 1; j >= 0; j -= 1) {
            const tagMatch = /<([a-zA-Z0-9_\-]+)/.exec(openTags[j]!)
            if (tagMatch) {
                closingTags += `</${tagMatch[1]}>`
            }
        }

        lines.push(lineWithOpenTags + closingTags)
    }

    return lines
}

/**
 * Highlights plain text code using highlight.js with safe fallback.
 */
export function highlightCodeToLines(code: string, fileName: string): string[] {
    let lang = SPECIAL_FILES_MAP[fileName]
    if (!lang) {
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        lang = EXT_TO_LANGUAGE[ext]
    }

    try {
        if (lang && hljs.getLanguage(lang)) {
            const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
            return splitHtmlIntoLines(result.value)
        }
        const auto = hljs.highlightAuto(code)
        if (auto.value) {
            return splitHtmlIntoLines(auto.value)
        }
    } catch {
        // Fallback to unhighlighted plain lines
    }

    return code.split('\n')
}
