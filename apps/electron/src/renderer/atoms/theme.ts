/**
 * 主题状态原子
 *
 * 仅支持浅色、深色和跟随系统。旧特殊风格设置只用于兼容读取，
 * 在缓存、跨窗口事件和 DOM 应用入口统一恢复为普通主题。
 */

import { atom } from 'jotai'
import { normalizeThemeMode, type ThemeMode, type ThemeStyle } from '../../types'

const THEME_CACHE_KEY = 'snap-theme-mode'
const THEME_STYLE_CACHE_KEY = 'snap-theme-style'

/** 缓存普通主题，并清除旧特殊风格缓存，避免下次启动重新应用。 */
function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, normalizeThemeMode(mode))
    localStorage.removeItem(THEME_STYLE_CACHE_KEY)
  } catch {
    // localStorage 不可用时忽略。
  }
}

function getCachedThemeMode(): ThemeMode {
  try {
    const mode = normalizeThemeMode(localStorage.getItem(THEME_CACHE_KEY))
    cacheThemeMode(mode)
    return mode
  } catch {
    return normalizeThemeMode(undefined)
  }
}

function getInitialSystemIsDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

const selectedThemeModeAtom = atom<ThemeMode>(getCachedThemeMode())

/** 所有写入都归一，防止旧窗口或旧配置把已删除的特殊模式写回状态。 */
export const themeModeAtom = atom(
  (get) => get(selectedThemeModeAtom),
  (_get, set, mode: ThemeMode) => set(selectedThemeModeAtom, normalizeThemeMode(mode)),
)

/** 仅保留读取兼容，特殊风格不再影响主题。 */
export const themeStyleAtom = atom<ThemeStyle>('default')

export const systemIsDarkAtom = atom<boolean>(getInitialSystemIsDark())

export const resolvedThemeAtom = atom<'light' | 'dark'>((get) => {
  const mode = normalizeThemeMode(get(themeModeAtom))
  return mode === 'system' ? (get(systemIsDarkAtom) ? 'dark' : 'light') : mode
})

/**
 * 应用普通主题，并移除前一版本遗留的全部特殊风格类。
 * 保留第二参数仅用于旧调用兼容，不再读取或应用其中的样式。
 * 状态相同时不修改 DOM，避免无意义的重绘。
 */
export function applyThemeToDOM(
  themeMode: unknown,
  _legacyThemeStyle: unknown = 'default',
  systemIsDark: boolean = true,
): void {
  const html = document.documentElement
  const mode = normalizeThemeMode(themeMode)
  const targetIsDark = mode === 'system' ? systemIsDark : mode === 'dark'
  const legacyClasses = Array.from(html.classList).filter((className) => className.startsWith('theme-'))

  if (legacyClasses.length > 0) html.classList.remove(...legacyClasses)
  if (html.classList.contains('dark') !== targetIsDark) {
    html.classList.toggle('dark', targetIsDark)
  }
}

/** 加载配置并监听系统 / 跨窗口主题变更，旧样式始终归一为 default。 */
export async function initializeTheme(
  setThemeMode: (mode: ThemeMode) => void,
  setSystemIsDark: (isDark: boolean) => void,
  setThemeStyle?: (style: ThemeStyle) => void,
): Promise<() => void> {
  const settings = await window.electronAPI.getSettings()
  const mode = normalizeThemeMode(settings.themeMode)
  setThemeMode(mode)
  cacheThemeMode(mode)
  setThemeStyle?.('default')

  setSystemIsDark(await window.electronAPI.getSystemTheme())

  const cleanupSystem = window.electronAPI.onSystemThemeChanged(setSystemIsDark)
  const cleanupThemeSettings = window.electronAPI.onThemeSettingsChanged((payload) => {
    const nextMode = normalizeThemeMode(payload.themeMode)
    setThemeMode(nextMode)
    cacheThemeMode(nextMode)
    setThemeStyle?.('default')
  })

  return () => {
    cleanupSystem()
    cleanupThemeSettings()
  }
}

/** 同时更新缓存和主进程配置，写入时清除旧特殊风格。 */
export async function updateThemeMode(mode: ThemeMode): Promise<void> {
  const normalizedMode = normalizeThemeMode(mode)
  cacheThemeMode(normalizedMode)
  await window.electronAPI.updateSettings({ themeMode: normalizedMode, themeStyle: 'default' })
}
