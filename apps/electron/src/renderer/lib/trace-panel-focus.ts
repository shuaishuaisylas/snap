interface TracePanelFocusState {
  panelOpen: boolean
  activeTab?: string
  split?: { leftTab: string; rightTab: string } | null
  /** 用户明确点击网页或打开链接时，允许切换到其目标。 */
  explicitUserRequest?: boolean
}

/** 被动 Agent 活动不得替换用户正在阅读的轨迹，也不得替换分屏中的轨迹 Pane。 */
export function shouldPreserveTracePanelFocus(state: TracePanelFocusState): boolean {
  if (!state.panelOpen || state.explicitUserRequest) return false
  return state.activeTab === 'trace'
    || state.split?.leftTab === 'trace'
    || state.split?.rightTab === 'trace'
}
