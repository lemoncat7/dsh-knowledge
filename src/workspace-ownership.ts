const WORKSPACE_ACTIVATE_EVENT = '@lemoncat7/dsh-plugin-ui/workspace-activate'

interface WorkspaceActivateDetail {
  pluginId: string
}

/** Claim the conversation workspace while remaining compatible with installed plugin versions. */
export function activatePluginWorkspace(pluginId: string): void {
  window.dispatchEvent(new CustomEvent<WorkspaceActivateDetail>(WORKSPACE_ACTIVATE_EVENT, {
    detail: { pluginId },
  }))
}

/** Close this workspace when another plugin claims the conversation area. */
export function observePluginWorkspace(pluginId: string, close: () => void): () => void {
  const onActivate = (event: Event): void => {
    const detail = (event as CustomEvent<WorkspaceActivateDetail>).detail
    if (detail?.pluginId !== pluginId) close()
  }
  window.addEventListener(WORKSPACE_ACTIVATE_EVENT, onActivate)
  return () => window.removeEventListener(WORKSPACE_ACTIVATE_EVENT, onActivate)
}
