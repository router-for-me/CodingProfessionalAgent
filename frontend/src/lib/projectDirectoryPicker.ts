import { getHostBridge } from '@/application/services/hostTransport'

export interface ProjectDirectorySelection {
  name: string
  path: string
}

/** Open the native directory picker and normalize a cancelled selection to null. */
export async function pickProjectDirectory(
  title: string,
): Promise<ProjectDirectorySelection | null> {
  const bridge = getHostBridge()
  if (bridge?.SelectProjectDirectory) {
    const selection = await bridge.SelectProjectDirectory(title)
    if (!selection.name || !selection.path) return null
    return selection
  }
  return null
}
