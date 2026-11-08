import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'

const storage = new Map<string, string>([
  ['snap-theme-mode', 'special'],
  ['snap-theme-style', 'terminal-dark'],
])
const originalGlobals = new Map<string, PropertyDescriptor | undefined>(
  ['localStorage', 'window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
)
const rawLegacyMode: unknown = 'special'
let theme: typeof import('./theme')
let themeListener: ((payload: { themeMode: unknown; themeStyle?: unknown }) => void) | undefined
let systemListener: ((isDark: boolean) => void) | undefined
let cleanedListeners = 0
const savedUpdates: unknown[] = []

function installClasses(initial: string[]): { classes: Set<string>; mutationCount: () => number } {
  const classes = new Set(initial)
  let mutations = 0
  const classList = {
    contains: (value: string) => classes.has(value),
    remove: (...values: string[]) => {
      mutations += 1
      for (const value of values) classes.delete(value)
    },
    toggle: (value: string, force: boolean) => {
      mutations += 1
      if (force) classes.add(value)
      else classes.delete(value)
      return force
    },
    [Symbol.iterator]: () => classes.values(),
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { classList } },
  })
  return { classes, mutationCount: () => mutations }
}

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false }),
      electronAPI: {
        getSettings: async () => ({ themeMode: rawLegacyMode, themeStyle: 'terminal-dark' }),
        getSystemTheme: async () => false,
        onSystemThemeChanged: (listener: (isDark: boolean) => void) => {
          systemListener = listener
          return () => { cleanedListeners += 1 }
        },
        onThemeSettingsChanged: (listener: (payload: { themeMode: unknown; themeStyle?: unknown }) => void) => {
          themeListener = listener
          return () => { cleanedListeners += 1 }
        },
        updateSettings: async (patch: unknown) => { savedUpdates.push(patch) },
      },
    },
  })
  theme = await import('./theme')
})

afterAll(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

describe('移除特殊风格后的主题兼容', () => {
  test('Given 旧特殊风格缓存 When 首次建立主题状态 Then 立即跟随系统且移除旧样式缓存', () => {
    const store = createStore()

    expect(store.get(theme.themeModeAtom)).toBe('system')
    expect(store.get(theme.themeStyleAtom)).toBe('default')
    expect(store.get(theme.resolvedThemeAtom)).toBe('light')
    expect(storage.get('snap-theme-mode')).toBe('system')
    expect(storage.has('snap-theme-style')).toBe(false)
  })

  test('Given 旧配置和多个遗留主题类 When 应用主题 Then 清理全部特殊样式且重复应用不修改 DOM', () => {
    const dom = installClasses(['snap-main-window', 'theme-terminal-dark', 'theme-ocean-dark', 'dark'])

    theme.applyThemeToDOM(rawLegacyMode, 'terminal-dark', false)

    expect([...dom.classes]).toEqual(['snap-main-window'])
    const changes = dom.mutationCount()
    theme.applyThemeToDOM(rawLegacyMode, 'forest-light', false)
    expect(dom.mutationCount()).toBe(changes)
  })

  test('Given 普通模式 When 切换浅色、深色和系统主题 Then 仍按用户选择解析', () => {
    const dom = installClasses(['snap-main-window'])

    theme.applyThemeToDOM('dark', 'default', false)
    expect(dom.classes.has('dark')).toBe(true)
    theme.applyThemeToDOM('light', 'default', true)
    expect(dom.classes.has('dark')).toBe(false)
    theme.applyThemeToDOM('system', 'default', true)
    expect(dom.classes.has('dark')).toBe(true)
    theme.applyThemeToDOM('system', 'default', false)
    expect(dom.classes.has('dark')).toBe(false)
  })

  test('Given 主进程或旧窗口返回特殊风格 When 初始化及接收同步事件 Then 归一模式并保留系统监听清理', async () => {
    const modes: string[] = []
    const styles: string[] = []
    const systemThemes: boolean[] = []
    const cleanup = await theme.initializeTheme(
      (mode) => { modes.push(mode) },
      (isDark) => { systemThemes.push(isDark) },
      (style) => { styles.push(style) },
    )

    expect(modes).toEqual(['system'])
    expect(styles).toEqual(['default'])
    themeListener?.({ themeMode: rawLegacyMode, themeStyle: 'ocean-light' })
    systemListener?.(true)
    expect(modes).toEqual(['system', 'system'])
    expect(styles).toEqual(['default', 'default'])
    expect(systemThemes).toEqual([false, true])
    cleanup()
    expect(cleanedListeners).toBe(2)
  })

  test('Given 缓存仍含旧样式 When 用户切换普通模式 Then 持久化清除特殊风格并更新缓存', async () => {
    storage.set('snap-theme-style', 'terminal-dark')

    await theme.updateThemeMode('light')

    expect(savedUpdates).toEqual([{ themeMode: 'light', themeStyle: 'default' }])
    expect(storage.get('snap-theme-mode')).toBe('light')
    expect(storage.has('snap-theme-style')).toBe(false)
  })
})
