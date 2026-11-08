import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_THEME_MODE } from '../../types'
import * as configPaths from './config-paths'

type SettingsService = typeof import('./settings-service')

let service: SettingsService
let temporaryDirectory = ''
let settingsPath = ''
let restoreSettingsPath = (): void => {}

beforeAll(async () => {
  // 只替换设置文件路径；读写与原子保存均执行真实实现，不修改用户目录或环境变量。
  const settingsPathMock = spyOn(configPaths, 'getSettingsPath').mockImplementation(() => {
    if (!settingsPath) throw new Error('测试临时设置路径尚未建立')
    return settingsPath
  })
  restoreSettingsPath = () => { settingsPathMock.mockRestore() }
  service = await import('./settings-service')
})

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'snap-settings-service-'))
  settingsPath = join(temporaryDirectory, 'settings.json')
})

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true })
  settingsPath = ''
})

afterAll(() => {
  restoreSettingsPath()
})

function writeSettings(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value, null, 2)
  writeFileSync(settingsPath, serialized, 'utf-8')
  return serialized
}

function readStoredSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}

describe('旧主题设置归一与持久化', () => {
  test('Given 磁盘保留 special 与旧主题风格 When 读取设置 Then 使用 system/default 且不主动重写原文件', () => {
    const original = writeSettings({
      themeMode: 'special',
      themeStyle: 'waykeeper',
      agentModelId: 'user-selected-model',
    })

    const settings = service.getSettings()

    expect(settings.themeMode).toBe('system')
    expect(settings.themeStyle).toBe('default')
    expect(settings.agentModelId).toBe('user-selected-model')
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original)
  })

  test('Given 旧主题和其他用户设置 When 仅修改通知开关 Then 真实原子保存归一后的主题并保留其他字段', () => {
    const otherUserFields = {
      agentModelId: 'user-selected-model',
      onboardingCompleted: true,
      richTextRenderingEnabled: true,
      customUserMetadata: { project: '我的项目', tags: ['个人', '研究'] },
    }
    const original = writeSettings({
      ...otherUserFields,
      themeMode: 'special',
      themeStyle: 'waykeeper',
      notificationsEnabled: true,
    })

    const updated = service.updateSettings({ notificationsEnabled: false })
    const stored = readStoredSettings()

    expect(updated.themeMode).toBe('system')
    expect(updated.themeStyle).toBe('default')
    expect(updated.notificationsEnabled).toBe(false)
    expect(stored).toMatchObject({
      ...otherUserFields,
      themeMode: 'system',
      themeStyle: 'default',
      notificationsEnabled: false,
    })
    expect(service.getSettings().themeMode).toBe('system')
    expect(service.getSettings().themeStyle).toBe('default')
    expect(existsSync(`${settingsPath}.tmp`)).toBe(false)
    expect(readFileSync(`${settingsPath}.bak`, 'utf-8')).toBe(original)
  })

  test.each(['light', 'dark', 'system'] as const)(
    'Given 正常主题 %s When 读取并更新无关设置 Then 主题保持原值',
    (themeMode) => {
      writeSettings({ themeMode, themeStyle: 'default', agentModelId: 'user-selected-model' })

      expect(service.getSettings().themeMode).toBe(themeMode)
      service.updateSettings({ notificationsEnabled: false })

      expect(readStoredSettings()).toMatchObject({
        themeMode,
        themeStyle: 'default',
        agentModelId: 'user-selected-model',
        notificationsEnabled: false,
      })
    },
  )

  test.each(['unknown-mode', '', null, 42])(
    'Given 磁盘主题模式非法 %j When 读取并保存无关设置 Then 回退 DEFAULT_THEME_MODE',
    (themeMode) => {
      writeSettings({ themeMode, themeStyle: 'obsolete-style' })

      expect(service.getSettings().themeMode).toBe(DEFAULT_THEME_MODE)
      service.updateSettings({ notificationsEnabled: false })

      expect(readStoredSettings()).toMatchObject({
        themeMode: DEFAULT_THEME_MODE,
        themeStyle: 'default',
        notificationsEnabled: false,
      })
    },
  )
})

describe('移除通知音后旧配置不再激活', () => {
  test('Given 旧声音和视觉配置及其他用户资料 When 读取设置 Then 丢弃已移除功能且原文件保持不变', () => {
    const original = writeSettings({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      notificationSounds: { taskComplete: 'minimal', planningReminder: 'soft' },
      visionRelay: { enabled: true, channelId: 'previous-channel', modelId: 'old-model' },
      voiceDictation: { apiKey: 'fixture-history-only' },
      agentChannelId: 'kept-channel',
      customUserMetadata: { note: '保留用户字段' },
    })
    const settings = service.getSettings()
    expect(settings.notificationsEnabled).toBe(true)
    expect(settings).not.toHaveProperty('notificationSoundEnabled')
    expect(settings).not.toHaveProperty('notificationSounds')
    expect(settings).not.toHaveProperty('visionRelay')
    expect(settings).toMatchObject({ agentChannelId: 'kept-channel', voiceDictation: { apiKey: 'fixture-history-only' }, customUserMetadata: { note: '保留用户字段' } })
    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
  })

  test('Given 旧音效与未类型化更新 When 保存其他设置 Then 音效不能复活且备份保留原资料', () => {
    const original = writeSettings({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      notificationSounds: { permissionRequest: 'glass' },
      agentChannelId: 'kept-channel',
      voiceDictation: { apiKey: 'fixture-history-only' },
      customUserMetadata: { note: '保留用户字段' },
    })
    const untypedUpdate = { notificationsEnabled: false, notificationSoundEnabled: true, notificationSounds: { taskComplete: 'arcade' }, visionRelay: { enabled: true } }
    service.updateSettings(untypedUpdate)
    const stored = readStoredSettings()
    expect(stored).not.toHaveProperty('notificationSoundEnabled')
    expect(stored).not.toHaveProperty('notificationSounds')
    expect(stored).not.toHaveProperty('visionRelay')
    expect(stored).toMatchObject({ notificationsEnabled: false, agentChannelId: 'kept-channel', voiceDictation: { apiKey: 'fixture-history-only' }, customUserMetadata: { note: '保留用户字段' } })
    expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(original)
  })
})
