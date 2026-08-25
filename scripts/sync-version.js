import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

export function parseVersionFromTag(rawTagOrRef) {
  if (!rawTagOrRef || typeof rawTagOrRef !== 'string') {
    return null
  }

  let tag = rawTagOrRef.trim()

  // Strip git refs/tags/ prefix if present
  if (tag.startsWith('refs/tags/')) {
    tag = tag.slice('refs/tags/'.length).trim()
  }

  // If it's a branch ref (e.g. refs/heads/main), ignore
  if (tag.startsWith('refs/heads/') || tag.startsWith('refs/pull/')) {
    return null
  }

  // Strip leading 'v' or 'V' if followed by a number
  if (/^v\d/i.test(tag)) {
    tag = tag.slice(1)
  }

  // Validate semantic version format (relaxed: digits.digits.digits with optional prerelease)
  if (!/^\d+\.\d+(\.\d+)?(-[\w.-]+)?(\+[\w.-]+)?$/.test(tag)) {
    return null
  }

  return tag
}

export function syncVersion(targetVersion) {
  if (!targetVersion) {
    console.log('[sync-version] No valid version provided, keeping existing package versions.')
    return false
  }

  const pkgPaths = [
    path.join(ROOT_DIR, 'package.json'),
    path.join(ROOT_DIR, 'frontend', 'package.json'),
  ]

  let updated = false
  for (const pkgPath of pkgPaths) {
    if (!fs.existsSync(pkgPath)) continue

    const content = fs.readFileSync(pkgPath, 'utf8')
    const json = JSON.parse(content)

    if (json.version !== targetVersion) {
      json.version = targetVersion
      fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + '\n', 'utf8')
      console.log(`[sync-version] Updated ${path.relative(ROOT_DIR, pkgPath)} version to ${targetVersion}`)
      updated = true
    } else {
      console.log(`[sync-version] ${path.relative(ROOT_DIR, pkgPath)} already has version ${targetVersion}`)
    }
  }

  return updated
}

// Execute CLI when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] || process.env.TAG_NAME || process.env.GITHUB_REF || ''
  const resolvedVersion = parseVersionFromTag(input)

  if (resolvedVersion) {
    console.log(`[sync-version] Resolved version "${resolvedVersion}" from input "${input}"`)
    syncVersion(resolvedVersion)
  } else if (input) {
    console.log(`[sync-version] Input "${input}" is not a release tag, skipping version sync.`)
  } else {
    console.log('[sync-version] No input provided, skipping version sync.')
  }
}
