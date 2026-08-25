/**
 * Core error types for the Universal Plugin Platform.
 */

export class PluginError extends Error {
    readonly code: string
    readonly pluginId?: string

    constructor(message: string, options?: { code?: string; pluginId?: string; cause?: unknown }) {
        super(message, { cause: options?.cause })
        this.name = 'PluginError'
        this.code = options?.code ?? 'PLUGIN_ERROR'
        this.pluginId = options?.pluginId
    }
}

export class PluginManifestError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_MANIFEST_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginManifestError'
    }
}

export class PluginValidationError extends PluginError {
    readonly validationErrors: readonly string[]

    constructor(
        message: string,
        validationErrors: readonly string[] = [],
        options?: { pluginId?: string; cause?: unknown },
    ) {
        super(message, { code: 'PLUGIN_VALIDATION_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginValidationError'
        this.validationErrors = validationErrors
    }
}

export class DuplicatePluginSourceError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'DUPLICATE_PLUGIN_SOURCE', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'DuplicatePluginSourceError'
    }
}

export class PluginActivationError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_ACTIVATION_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginActivationError'
    }
}

export class PluginDeactivationError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_DEACTIVATION_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginDeactivationError'
    }
}

export class PluginDependencyError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_DEPENDENCY_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginDependencyError'
    }
}

export class PluginConflictError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_CONFLICT_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginConflictError'
    }
}

export class PluginCapabilityError extends PluginError {
    constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_CAPABILITY_ERROR', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginCapabilityError'
    }
}

export class PluginManagementUnavailableError extends PluginError {
    constructor(message: string = 'Plugin management service is unavailable', options?: { pluginId?: string; cause?: unknown }) {
        super(message, { code: 'PLUGIN_MANAGEMENT_UNAVAILABLE', pluginId: options?.pluginId, cause: options?.cause })
        this.name = 'PluginManagementUnavailableError'
    }
}

