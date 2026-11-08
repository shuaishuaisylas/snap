/**
 * 静音桌面通知与开关状态。旧通知音配置不再参与初始化或发送。
 */
import { atom } from 'jotai'

export const notificationsEnabledAtom = atom<boolean>(true)

export async function initializeNotifications(setEnabled: (enabled: boolean) => void): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setEnabled(settings.notificationsEnabled ?? true)
  } catch (error) {
    console.error('[通知] 初始化失败:', error)
  }
}

export async function updateNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ notificationsEnabled: enabled })
  } catch (error) {
    console.error('[通知] 更新设置失败:', error)
  }
}

export interface DesktopNotificationOptions {
  /** 点击通知时导航到对应会话。 */
  onNavigate?: () => void
  /** 阻塞操作可无视窗口焦点发送通知。 */
  force?: boolean
}

/** 所有平台都保留系统通知，始终显式静音，不创建任何音频播放对象。 */
export function sendDesktopNotification(
  title: string,
  body: string,
  enabled: boolean,
  options?: DesktopNotificationOptions,
): void {
  setTimeout(() => {
    if (!enabled) return
    if (!options?.force && document.hasFocus()) return
    const notification = new Notification(title, { body, silent: true })
    notification.onclick = () => {
      window.focus()
      options?.onNavigate?.()
    }
  }, 0)
}
