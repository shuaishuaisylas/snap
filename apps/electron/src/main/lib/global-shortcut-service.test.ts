import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const registrations = new Map<string, () => void>()
const registerCalls: string[] = []
const settings: {
  voiceDictation: { enabled: boolean; accessToken: string }
  shortcutOverrides: Record<string, { mac?: string | null; win?: string | null }>
} = {
  voiceDictation: { enabled: true, accessToken: 'opaque legacy fixture' },
  shortcutOverrides: {},
}

mock.module('electron', () => ({
  app: { isReady: () => true },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      registerCalls.push(accelerator)
      registrations.set(accelerator, callback)
      return true
    },
    unregister: (accelerator: string) => { registrations.delete(accelerator) },
    unregisterAll: () => { registrations.clear() },
  },
}))
mock.module('./settings-service', () => ({ getSettings: () => settings }))

const {
  registerGlobalShortcut,
  reregisterAllGlobalShortcuts,
  getGlobalShortcutRegistrationStatus,
  unregisterAllGlobalShortcuts,
} = await import('./global-shortcut-service')

beforeEach(() => {
  settings.shortcutOverrides = { 'voice-dictation': { mac: 'Ctrl+`', win: 'Ctrl+`' } }
  registerCalls.length = 0
})
afterEach(() => { unregisterAllGlobalShortcuts() })

describe('已删除语音功能的全局快捷键边界', () => {
  test('Given 历史启用语音和快捷键配置 When 注册或重载 Then 不能激活已移除ID且原配置不改写', () => {
    const before = JSON.stringify(settings)
    expect(registerGlobalShortcut('voice-dictation', () => { throw new Error('removed callback must not run') })).toBe(false)
    expect(registerCalls).toEqual([])
    expect(reregisterAllGlobalShortcuts()).toEqual({})
    expect(getGlobalShortcutRegistrationStatus()).toEqual({})
    expect(JSON.stringify(settings)).toBe(before)
  })

  test('Given 保留的快速任务和显示主窗口 When 注册重载并触发 Then 原有快捷键继续执行', () => {
    let quickTaskCalls = 0
    let showWindowCalls = 0
    settings.shortcutOverrides['quick-task'] = { mac: 'Alt+Shift+Space', win: 'Alt+Shift+Space' }
    expect(registerGlobalShortcut('quick-task', () => { quickTaskCalls += 1 })).toBe(true)
    expect(registerGlobalShortcut('show-main-window', () => { showWindowCalls += 1 })).toBe(true)
    expect(reregisterAllGlobalShortcuts()).toEqual({ 'quick-task': true, 'show-main-window': true })
    for (const callback of registrations.values()) callback()
    expect(quickTaskCalls).toBe(1)
    expect(showWindowCalls).toBe(1)
    expect(registerCalls).toContain('Alt+Shift+Space')
    expect(getGlobalShortcutRegistrationStatus()).toEqual({ 'quick-task': true, 'show-main-window': true })
  })
})
