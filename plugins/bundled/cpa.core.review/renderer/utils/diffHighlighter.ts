import { hljs } from '@cpa/plugin-ui'

const EXT_TO_LANGUAGE: Record<string, string> = {
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

const SPECIAL_FILES_MAP: Record<string, string> = {
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

export function detectLanguage(filename: string): string | null {
  const baseName = filename.split('/').pop() || filename
  if (SPECIAL_FILES_MAP[baseName]) {
    return SPECIAL_FILES_MAP[baseName]
  }
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex !== -1) {
    const ext = baseName.slice(dotIndex + 1).toLowerCase()
    return EXT_TO_LANGUAGE[ext] || null
  }
  return null
}

/**
 * Highlight a single line of code safely.
 */
export function highlightCodeLine(code: string, language: string | null): string {
  if (!code) return '&nbsp;'

  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    }
    // Plain text escaping fallback
    return hljs.highlightAuto(code).value
  } catch {
    // Basic HTML escaping
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }
}
