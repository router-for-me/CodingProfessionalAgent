import type { ProjectService } from '@cpa/plugin-api'
import { getDefaultHostServices } from '@cpa/plugin-ui'

/** Reveal a project source path in the host platform's file manager. */
export async function revealProjectPath(path: string, projectService?: ProjectService): Promise<void> {
    const service = projectService ?? getDefaultHostServices()?.projects
    if (service?.revealPath) {
        await service.revealPath(path)
    }
}
