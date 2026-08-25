import semver from 'semver'
import type { ResolvedPluginPackage } from '@cpa/plugin-api'

export interface ResolvePluginGraphInput {
    packages: readonly ResolvedPluginPackage[]
    enabledPluginIds: ReadonlySet<string>
    cpaVersion: string
}

export interface BlockedPlugin {
    pluginId: string
    reason: 'disabled' | 'missing-dependency' | 'incompatible-version' | 'dependency-cycle'
    dependencyId?: string
}

export interface ResolvedPluginGraph {
    activationOrder: readonly ResolvedPluginPackage[]
    blocked: readonly BlockedPlugin[]
}

/**
 * Depth-first search reachability check in a directed graph.
 */
function canReach(
    start: string,
    target: string,
    adj: Map<string, Set<string>>,
    visited: Set<string> = new Set(),
): boolean {
    if (start === target) {
        return true
    }
    visited.add(start)
    const neighbors = adj.get(start)
    if (!neighbors) {
        return false
    }
    for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
            if (canReach(neighbor, target, adj, visited)) {
                return true
            }
        }
    }
    return false
}

/**
 * Compare two plugin packages for deterministic tie-breaking in topological sort.
 * Ordering: activationPriority (ascending, default 1000) -> manifest.id (lexicographical).
 */
function comparePlugins(a: ResolvedPluginPackage, b: ResolvedPluginPackage): number {
    const priorityA = a.manifest.activationPriority ?? 1000
    const priorityB = b.manifest.activationPriority ?? 1000
    if (priorityA !== priorityB) {
        return priorityA - priorityB
    }
    return a.manifest.id.localeCompare(b.manifest.id)
}

/**
 * Find Strongly Connected Components using Tarjan's algorithm.
 */
function findStronglyConnectedComponents(
    nodes: Iterable<string>,
    adj: Map<string, Set<string>>,
): string[][] {
    let index = 0
    const indices = new Map<string, number>()
    const lowlink = new Map<string, number>()
    const stack: string[] = []
    const onStack = new Set<string>()
    const sccs: string[][] = []

    function strongConnect(v: string) {
        indices.set(v, index)
        lowlink.set(v, index)
        index++
        stack.push(v)
        onStack.add(v)

        const neighbors = adj.get(v) ?? new Set()
        for (const w of neighbors) {
            if (!indices.has(w)) {
                strongConnect(w)
                lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
            } else if (onStack.has(w)) {
                lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
            }
        }

        if (lowlink.get(v) === indices.get(v)) {
            const scc: string[] = []
            let w: string
            do {
                w = stack.pop()!
                onStack.delete(w)
                scc.push(w)
            } while (w !== v)
            sccs.push(scc)
        }
    }

    for (const node of nodes) {
        if (!indices.has(node)) {
            strongConnect(node)
        }
    }

    return sccs
}

/**
 * Resolves the plugin dependency graph, validating CPA version, enabled state,
 * required/optional dependencies, detecting cycles, and providing a stable
 * deterministic activation order.
 */
export function resolvePluginGraph(input: ResolvePluginGraphInput): ResolvedPluginGraph {
    const { packages, enabledPluginIds, cpaVersion } = input

    const packageMap = new Map<string, ResolvedPluginPackage>()
    for (const pkg of packages) {
        packageMap.set(pkg.manifest.id, pkg)
    }

    const blockedMap = new Map<string, BlockedPlugin>()

    // Step 1: Validate CPA engine version & enabled state for each package
    for (const pkg of packages) {
        const id = pkg.manifest.id
        const cpaEngine = pkg.manifest.engines?.cpa

        if (!cpaEngine || !semver.satisfies(cpaVersion, cpaEngine, { includePrerelease: true })) {
            blockedMap.set(id, {
                pluginId: id,
                reason: 'incompatible-version',
            })
            continue
        }

        if (!enabledPluginIds.has(id)) {
            blockedMap.set(id, {
                pluginId: id,
                reason: 'disabled',
            })
            continue
        }
    }

    // Step 2: Validate required dependencies and propagate cascading blocks
    let changed = true
    while (changed) {
        changed = false
        for (const pkg of packages) {
            const id = pkg.manifest.id
            if (blockedMap.has(id)) {
                continue
            }

            const requiredDeps = pkg.manifest.dependencies ?? {}
            for (const [depId, versionRange] of Object.entries(requiredDeps)) {
                const depPkg = packageMap.get(depId)
                if (!depPkg) {
                    blockedMap.set(id, {
                        pluginId: id,
                        reason: 'missing-dependency',
                        dependencyId: depId,
                    })
                    changed = true
                    break
                }

                if (blockedMap.has(depId)) {
                    blockedMap.set(id, {
                        pluginId: id,
                        reason: 'missing-dependency',
                        dependencyId: depId,
                    })
                    changed = true
                    break
                }

                if (!semver.satisfies(depPkg.manifest.version, versionRange, { includePrerelease: true })) {
                    blockedMap.set(id, {
                        pluginId: id,
                        reason: 'incompatible-version',
                        dependencyId: depId,
                    })
                    changed = true
                    break
                }
            }
        }
    }

    // Step 3: Check for dependency cycles among remaining candidate plugins
    let cycleFound = true
    while (cycleFound) {
        cycleFound = false
        const candidates = new Set<string>()
        for (const pkg of packages) {
            if (!blockedMap.has(pkg.manifest.id)) {
                candidates.add(pkg.manifest.id)
            }
        }

        // Build required dependency adjacency list for candidates
        const reqAdj = new Map<string, Set<string>>()
        for (const id of candidates) {
            reqAdj.set(id, new Set())
            const pkg = packageMap.get(id)!
            const requiredDeps = pkg.manifest.dependencies ?? {}
            for (const depId of Object.keys(requiredDeps)) {
                if (candidates.has(depId)) {
                    reqAdj.get(id)!.add(depId)
                }
            }
        }

        const sccs = findStronglyConnectedComponents(candidates, reqAdj)
        for (const scc of sccs) {
            const isSelfCycle = scc.length === 1 && reqAdj.get(scc[0])?.has(scc[0]) === true
            if (scc.length > 1 || isSelfCycle) {
                cycleFound = true
                for (const member of scc) {
                    blockedMap.set(member, {
                        pluginId: member,
                        reason: 'dependency-cycle',
                    })
                }
            }
        }

        // Propagate blocks to dependents of newly blocked cycle members
        if (cycleFound) {
            let cascadeChanged = true
            while (cascadeChanged) {
                cascadeChanged = false
                for (const pkg of packages) {
                    const id = pkg.manifest.id
                    if (blockedMap.has(id)) {
                        continue
                    }
                    const requiredDeps = pkg.manifest.dependencies ?? {}
                    for (const depId of Object.keys(requiredDeps)) {
                        if (blockedMap.has(depId)) {
                            blockedMap.set(id, {
                                pluginId: id,
                                reason: 'missing-dependency',
                                dependencyId: depId,
                            })
                            cascadeChanged = true
                            break
                        }
                    }
                }
            }
        }
    }

    // Step 4: Build complete DAG with required and safe optional dependencies
    const eligibleIds = new Set<string>()
    for (const pkg of packages) {
        if (!blockedMap.has(pkg.manifest.id)) {
            eligibleIds.add(pkg.manifest.id)
        }
    }

    const adj = new Map<string, Set<string>>()
    for (const id of eligibleIds) {
        adj.set(id, new Set())
    }

    // Add required dependencies (guaranteed to be cycle-free DAG)
    for (const id of eligibleIds) {
        const pkg = packageMap.get(id)!
        const requiredDeps = pkg.manifest.dependencies ?? {}
        for (const depId of Object.keys(requiredDeps)) {
            if (eligibleIds.has(depId)) {
                adj.get(id)!.add(depId)
            }
        }
    }

    // Add optional dependencies if available, compatible, and cycle-free
    for (const id of eligibleIds) {
        const pkg = packageMap.get(id)!
        const optionalDeps = pkg.manifest.optionalDependencies ?? {}
        for (const [depId, versionRange] of Object.entries(optionalDeps)) {
            if (!eligibleIds.has(depId)) {
                continue
            }
            const depPkg = packageMap.get(depId)!
            if (!semver.satisfies(depPkg.manifest.version, versionRange, { includePrerelease: true })) {
                continue
            }
            // Check if adding id -> depId creates a cycle (i.e. depId already reaches id)
            if (!canReach(depId, id, adj)) {
                adj.get(id)!.add(depId)
            }
        }
    }

    // Step 5: Topological sort using Kahn's algorithm with priority tie-breaking
    // In our adj map: adj.get(u) is the set of dependencies that u needs (u depends on v).
    // So inDegree(u) is adj.get(u).size.
    // dependents(v) is all u where adj.get(u).has(v).
    const inDegree = new Map<string, number>()
    const dependents = new Map<string, Set<string>>()

    for (const id of eligibleIds) {
        inDegree.set(id, adj.get(id)!.size)
        dependents.set(id, new Set())
    }

    for (const [id, deps] of adj.entries()) {
        for (const depId of deps) {
            dependents.get(depId)!.add(id)
        }
    }

    const readyQueue: ResolvedPluginPackage[] = []
    for (const id of eligibleIds) {
        if (inDegree.get(id) === 0) {
            readyQueue.push(packageMap.get(id)!)
        }
    }

    const activationOrder: ResolvedPluginPackage[] = []

    while (readyQueue.length > 0) {
        readyQueue.sort(comparePlugins)
        const current = readyQueue.shift()!
        activationOrder.push(current)

        const currentDependents = dependents.get(current.manifest.id) ?? new Set()
        for (const depId of currentDependents) {
            const newDegree = inDegree.get(depId)! - 1
            inDegree.set(depId, newDegree)
            if (newDegree === 0) {
                readyQueue.push(packageMap.get(depId)!)
            }
        }
    }

    // Sort blocked list for deterministic output
    const blockedList = Array.from(blockedMap.values()).sort((a, b) =>
        a.pluginId.localeCompare(b.pluginId),
    )

    return {
        activationOrder: Object.freeze(activationOrder),
        blocked: Object.freeze(blockedList),
    }
}
