import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  agentDiffPanelTabAtom,
  agentSessionComponentTabsAtomFamily,
  agentSidePanelOpenAtomFamily,
  revealChangedWorkspaceComponentAtom,
} from './agent-atoms'
import type { AgentSidePanelTab } from './agent-atoms'
import { createRightWorkspaceSplit, sanitizeRightWorkspaceSplit } from '../lib/right-workspace-split'
import { getPreviousRightPanelTab, recordRightPanelTabVisit } from '../lib/right-panel-tab-history'

describe('轨迹接入现有右侧工作区', () => {
  test('Given 用户查看轨迹 When Agent 修改项目记忆 Then 添加记忆入口但保留轨迹焦点且不影响其他会话', () => {
    const store = createStore()
    store.set(agentDiffPanelTabAtom, new Map([['reading', 'trace'], ['other', 'changes']]))
    store.set(agentSidePanelOpenAtomFamily('reading'), true)

    store.set(revealChangedWorkspaceComponentAtom, { sessionId: 'reading', component: 'memory' })

    expect(store.get(agentDiffPanelTabAtom).get('reading')).toBe('trace')
    expect(store.get(agentDiffPanelTabAtom).get('other')).toBe('changes')
    expect(store.get(agentSessionComponentTabsAtomFamily('reading'))).toContain('memory')
    expect(store.get(agentSessionComponentTabsAtomFamily('other'))).toEqual([])
  })

  test('Given 轨迹和改动并排 When 动态浏览器标签关闭 Then 保留固定轨迹面板', () => {
    const split = createRightWorkspaceSplit('trace', 'changes', 'right', 0.5)!
    const available = new Set<AgentSidePanelTab>(['files', 'changes', 'trace'])
    const restored = sanitizeRightWorkspaceSplit(split, available)
    expect(restored.split?.leftTab).toBe('trace')
    expect(restored.split?.rightTab).toBe('changes')
  })

  test('Given 从轨迹进入临时预览 When 关闭预览 Then 返回轨迹而不是重置到文件', () => {
    const history = recordRightPanelTabVisit(recordRightPanelTabVisit(['files'], 'trace'), 'preview:one')
    expect(getPreviousRightPanelTab(history, 'preview:one', new Set<AgentSidePanelTab>(['files', 'trace']))).toBe('trace')
  })
})
