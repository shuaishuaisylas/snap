import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initializeNotifications, sendDesktopNotification, updateNotificationsEnabled } from './notifications'

const globalKeys = ['window', 'document', 'Notification', 'AudioContext', 'navigator'] as const
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()
const notifications: Array<{ title: string; options: NotificationOptions; onclick?: () => void }> = []
let focused = false
let focusCalls = 0
let audioCalls = 0
let navigations = 0
let saved: unknown

beforeEach(() => {
  for (const key of globalKeys) originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  notifications.length = 0
  focused = false
  focusCalls = 0
  audioCalls = 0
  navigations = 0
  saved = undefined
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    focus: () => { focusCalls += 1 },
    electronAPI: {
      getSettings: async () => ({ notificationsEnabled: true, notificationSoundEnabled: true, notificationSounds: { taskComplete: 'arcade' } }),
      updateSettings: async (value: unknown) => { saved = value },
    },
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hasFocus: () => focused } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Win32' } })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { audioCalls += 1 } } })
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: class {
    onclick?: () => void
    constructor(readonly title: string, readonly options: NotificationOptions) { notifications.push(this) }
  } })
})

afterEach(() => {
  for (const key of globalKeys) {
    const descriptor = originalDescriptors.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  originalDescriptors.clear()
})

const flushNotifications = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

describe('静音桌面通知', () => {
  test('Given 旧配置仍开启音效 When 初始化并发送通知 Then 正常弹出静音通知且不创建音频对象', async () => {
    let enabled = false
    await initializeNotifications((value) => { enabled = value })
    sendDesktopNotification('Agent 任务完成', '任务已完成', enabled, { onNavigate: () => { navigations += 1 } })
    await flushNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options).toEqual({ body: '任务已完成', silent: true })
    expect(audioCalls).toBe(0)
    notifications[0]?.onclick?.()
    expect(focusCalls).toBe(1)
    expect(navigations).toBe(1)
  })

  test('Given 禁用通知或窗口已聚焦 When 普通通知触发 Then 不弹通知；阻塞通知仍保持静音', async () => {
    focused = true
    sendDesktopNotification('被禁用', '内容', false, { force: true })
    sendDesktopNotification('已聚焦', '内容', true)
    sendDesktopNotification('等待审批', '请确认', true, { force: true })
    await flushNotifications()
    expect(notifications.map((notification) => notification.title)).toEqual(['等待审批'])
    expect(notifications[0]?.options.silent).toBe(true)
    expect(audioCalls).toBe(0)
  })

  test('Given 桌面通知开关变更 When 保存 Then 仅保存通知开关而没有音效设置', async () => {
    await updateNotificationsEnabled(false)
    expect(saved).toEqual({ notificationsEnabled: false })
  })
})
