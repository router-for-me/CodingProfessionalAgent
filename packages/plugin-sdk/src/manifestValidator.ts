import {
    type ContributionKind,
    isValidCapabilityPattern,
    type PluginCriticality,
    type PluginEntryKind,
    type PluginManifest,
    PluginManifestError,
} from '@cpa/plugin-api'
import semver from 'semver'

const VALID_ENTRY_KINDS: ReadonlySet<string> = new Set<PluginEntryKind>(['main', 'renderer', 'agent'])
const VALID_CRITICALITIES: ReadonlySet<string> = new Set<PluginCriticality>(['platform', 'required', 'optional'])
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/

export const VALID_CONTRIBUTION_KINDS: ReadonlySet<ContributionKind> = new Set<ContributionKind>([
    'service',
    'rpc',
    'native-event',
    'route',
    'background-job',
    'storage',
    'lifecycle',
    'slot',
    'floating',
    'component-wrapper',
    'action',
    'view',
    'navigation',
    'settings-group',
    'settings',
    'panel',
    'composer',
    'chat-renderer',
    'tool-factory',
    'resource-provider',
    'hook',
    'protocol',
    'protocol-middleware',
    'model-catalog',
])

export interface ManifestValidationResult<T = PluginManifest> {
    valid: boolean
    errors: string[]
    manifest?: T
}

/**
 * Validates a plugin manifest strictly according to the universal platform contract.
 * id, name, version, apiVersion, engines (with cpa), entries, dependencies, capabilities,
 * and contributes are all required.
 */
export function validatePluginManifest(raw: unknown): ManifestValidationResult<PluginManifest> {
    const errors: string[] = []

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
            valid: false,
            errors: ['Plugin manifest must be a non-null object'],
        }
    }

    const obj = raw as Record<string, unknown>

    // 1. Validate id
    if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
        errors.push('Manifest "id" is required and must be a non-empty string')
    } else if (!VALID_ID_PATTERN.test(obj.id)) {
        errors.push(`Manifest "id" "${obj.id}" is invalid (must contain only alphanumeric characters, dashes, dots, and underscores)`)
    }

    // 2. Validate name
    if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
        errors.push('Manifest "name" is required and must be a non-empty string')
    }

    // 3. Validate version (must be valid semver)
    if (typeof obj.version !== 'string' || obj.version.trim().length === 0) {
        errors.push('Manifest "version" is required and must be a non-empty string')
    } else if (!semver.valid(obj.version)) {
        errors.push(`Manifest "version" "${obj.version}" is not a valid semver version`)
    }

    // 4. Validate apiVersion
    if (typeof obj.apiVersion !== 'string' || obj.apiVersion.trim().length === 0) {
        errors.push('Manifest "apiVersion" is required and must be a non-empty string')
    }

    // 5. Validate engines
    if (!obj.engines || typeof obj.engines !== 'object' || Array.isArray(obj.engines)) {
        errors.push('Manifest "engines" is required and must be an object')
    } else {
        const enginesObj = obj.engines as Record<string, unknown>
        if (typeof enginesObj.cpa !== 'string' || enginesObj.cpa.trim().length === 0) {
            errors.push('Manifest "engines.cpa" is required and must be a semver range string (e.g. "^1.0.0")')
        }
    }

    // 6. Validate entries (required object)
    if (obj.entries === undefined || !obj.entries || typeof obj.entries !== 'object' || Array.isArray(obj.entries)) {
        errors.push('Manifest "entries" is required and must be an object (use {} if none)')
    } else {
        const entriesObj = obj.entries as Record<string, unknown>
        for (const [key, val] of Object.entries(entriesObj)) {
            if (!VALID_ENTRY_KINDS.has(key)) {
                errors.push(`Manifest "entries" contains unknown runtime kind "${key}". Valid kinds: ${Array.from(VALID_ENTRY_KINDS).join(', ')}`)
            } else if (typeof val !== 'string' || val.trim().length === 0) {
                errors.push(`Manifest "entries.${key}" must be a non-empty string file path`)
            }
        }
    }

    // 7. Validate dependencies (required object)
    if (obj.dependencies === undefined || !obj.dependencies || typeof obj.dependencies !== 'object' || Array.isArray(obj.dependencies)) {
        errors.push('Manifest "dependencies" is required and must be an object (use {} if none)')
    } else {
        for (const [depId, versionRange] of Object.entries(obj.dependencies as Record<string, unknown>)) {
            if (typeof versionRange !== 'string') {
                errors.push(`Manifest "dependencies.${depId}" must be a semver version range string`)
            }
        }
    }

    // 8. Validate capabilities (required array)
    if (obj.capabilities === undefined || !Array.isArray(obj.capabilities)) {
        errors.push('Manifest "capabilities" is required and must be an array (use [] if none)')
    } else {
        const seenCapabilities = new Set<string>()
        for (let i = 0; i < obj.capabilities.length; i++) {
            const cap = obj.capabilities[i]
            if (typeof cap !== 'string' || cap.trim().length === 0) {
                errors.push(`Manifest "capabilities[${i}]" must be a non-empty string`)
            } else if (!isValidCapabilityPattern(cap)) {
                errors.push(`Invalid capability pattern "${cap}" in manifest capabilities`)
            } else if (seenCapabilities.has(cap)) {
                errors.push(`Duplicate capability "${cap}" declared in manifest capabilities`)
            } else {
                seenCapabilities.add(cap)
            }
        }
    }

    // 9. Validate contributes (required object)
    if (obj.contributes === undefined || !obj.contributes || typeof obj.contributes !== 'object' || Array.isArray(obj.contributes)) {
        errors.push('Manifest "contributes" is required and must be an object (use {} if none)')
    } else {
        const contributesObj = obj.contributes as Record<string, unknown>
        for (const [kind, ids] of Object.entries(contributesObj)) {
            if (!VALID_CONTRIBUTION_KINDS.has(kind as ContributionKind)) {
                errors.push(`Manifest "contributes" contains unknown contribution kind "${kind}". Valid kinds: ${Array.from(VALID_CONTRIBUTION_KINDS).join(', ')}`)
            } else if (!Array.isArray(ids)) {
                errors.push(`Manifest "contributes.${kind}" must be an array of contribution ID strings`)
            } else {
                const seenIds = new Set<string>()
                for (let i = 0; i < ids.length; i++) {
                    const id = ids[i]
                    if (typeof id !== 'string' || id.trim().length === 0) {
                        errors.push(`Manifest "contributes.${kind}[${i}]" must be a non-empty string ID`)
                    } else if (seenIds.has(id)) {
                        errors.push(`Duplicate contribution ID "${id}" declared in contributes.${kind}`)
                    } else {
                        seenIds.add(id)
                    }
                }
            }
        }
    }

    // 10. Validate criticality (optional)
    if (obj.criticality !== undefined) {
        if (typeof obj.criticality !== 'string' || !VALID_CRITICALITIES.has(obj.criticality)) {
            errors.push(`Manifest "criticality" must be one of: ${Array.from(VALID_CRITICALITIES).join(', ')}`)
        }
    }

    // 11. Validate activationEvents (optional)
    if (obj.activationEvents !== undefined) {
        if (!Array.isArray(obj.activationEvents)) {
            errors.push('Manifest "activationEvents" must be an array of strings if provided')
        } else {
            for (let i = 0; i < obj.activationEvents.length; i++) {
                const event = obj.activationEvents[i]
                if (typeof event !== 'string' || event.trim().length === 0) {
                    errors.push(`Manifest "activationEvents[${i}]" must be a non-empty string`)
                }
            }
        }
    }

    // 12. Validate activationPriority (optional)
    if (obj.activationPriority !== undefined && typeof obj.activationPriority !== 'number') {
        errors.push('Manifest "activationPriority" must be a number if provided')
    }

    // 13. Validate optionalDependencies (optional)
    if (obj.optionalDependencies !== undefined) {
        if (!obj.optionalDependencies || typeof obj.optionalDependencies !== 'object' || Array.isArray(obj.optionalDependencies)) {
            errors.push('Manifest "optionalDependencies" must be an object if provided')
        } else {
            for (const [depId, versionRange] of Object.entries(obj.optionalDependencies as Record<string, unknown>)) {
                if (typeof versionRange !== 'string') {
                    errors.push(`Manifest "optionalDependencies.${depId}" must be a semver version range string`)
                }
            }
        }
    }

    // 14. Validate configurationSchema (optional)
    if (obj.configurationSchema !== undefined) {
        if (!obj.configurationSchema || typeof obj.configurationSchema !== 'object' || Array.isArray(obj.configurationSchema)) {
            errors.push('Manifest "configurationSchema" must be an object if provided')
        }
    }

    if (errors.length > 0) {
        return {
            valid: false,
            errors,
        }
    }

    return {
        valid: true,
        errors: [],
        manifest: raw as PluginManifest,
    }
}

/**
 * Parses and strictly validates a plugin manifest according to the universal platform contract.
 * Throws PluginManifestError if the manifest is invalid.
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
    const result = validatePluginManifest(raw)
    if (!result.valid || !result.manifest) {
        throw new PluginManifestError(`Invalid plugin manifest: ${result.errors.join('; ')}`, {
            pluginId: typeof (raw as any)?.id === 'string' ? (raw as any).id : undefined,
        })
    }
    return result.manifest
}
