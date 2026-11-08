import { describe, expect, test } from 'bun:test'
import { shouldPreserveTracePanelFocus } from './trace-panel-focus'

describe('轨迹面板的被动活动焦点保护', () => {
  test('Given 当前正在阅读轨迹 When 收到被动 Agent 活动 Then 保留当前面板', () => {
    expect(shouldPreserveTracePanelFocus({ panelOpen: true, activeTab: 'trace' })).toBe(true)
  })

  test('Given 分屏含轨迹但焦点在另一栏 When 收到被动活动 Then 不替换轨迹所在 Pane', () => {
    expect(shouldPreserveTracePanelFocus({
      panelOpen: true,
      activeTab: 'changes',
      split: { leftTab: 'trace', rightTab: 'changes' },
    })).toBe(true)
    expect(shouldPreserveTracePanelFocus({
      panelOpen: true,
      activeTab: 'files',
      split: { leftTab: 'files', rightTab: 'trace' },
    })).toBe(true)
  })

  test('Given 轨迹已收起 When 收到活动 Then 保留既有自动打开行为', () => {
    expect(shouldPreserveTracePanelFocus({ panelOpen: false, activeTab: 'trace' })).toBe(false)
    expect(shouldPreserveTracePanelFocus({
      panelOpen: false,
      activeTab: 'changes',
      split: { leftTab: 'trace', rightTab: 'changes' },
    })).toBe(false)
  })

  test('Given 用户正在看普通面板 When 收到活动 Then 不改变旧有激活规则', () => {
    expect(shouldPreserveTracePanelFocus({ panelOpen: true, activeTab: 'changes' })).toBe(false)
    expect(shouldPreserveTracePanelFocus({ panelOpen: true, activeTab: 'files', split: null })).toBe(false)
    expect(shouldPreserveTracePanelFocus({ panelOpen: true })).toBe(false)
  })

  test('Given 轨迹或分屏正在显示 When 用户明确打开网页 Then 允许切换到用户指定目标', () => {
    expect(shouldPreserveTracePanelFocus({
      panelOpen: true,
      activeTab: 'trace',
      explicitUserRequest: true,
    })).toBe(false)
    expect(shouldPreserveTracePanelFocus({
      panelOpen: true,
      activeTab: 'files',
      split: { leftTab: 'files', rightTab: 'trace' },
      explicitUserRequest: true,
    })).toBe(false)
  })
})
