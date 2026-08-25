import { getHostBridge } from '@/application/services/hostTransport'

/** Reveal a project source path in the host platform's file manager. */
export async function revealProjectPath(path: string): Promise<void> {
  const bridge = getHostBridge()
  if (bridge?.RevealInFileManager) {
    await bridge.RevealInFileManager(path)
  }
}
