import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../../renderer/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1]

function applyTheme(storage: Map<string, string>, systemDark = false): string[] {
  const classes = new Set<string>()
  runInNewContext(script!, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: { documentElement: { classList: { toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name) } } } },
  })
  return [...classes]
}

describe('Snap 挂载前主题', () => {
  test('Given current cached settings When mounted twice Then model and sidebar values survive while special themes normalize', () => {
    expect(script).toBeDefined()
    const storage = new Map([['snap-selected-model', 'chosen-model'], ['snap-sidebar-collapsed', 'false'], ['snap-theme-mode', 'special'], ['snap-theme-style', 'forest'], ['unrelated-key', 'unchanged']])
    expect(applyTheme(storage)).toEqual([])
    expect(applyTheme(storage)).toEqual([])
    expect(storage.get('snap-selected-model')).toBe('chosen-model')
    expect(storage.get('snap-sidebar-collapsed')).toBe('false')
    expect(storage.get('snap-theme-mode')).toBe('system')
    expect(storage.get('unrelated-key')).toBe('unchanged')
    expect(storage.has('snap-theme-style')).toBe(false)
  })
  test('Given a new environment When mounted Then the ordinary default theme is dark', () => {
    const storage = new Map<string, string>()
    expect(applyTheme(storage)).toEqual(['dark'])
    expect(storage.get('snap-theme-mode')).toBe('dark')
  })
  test('Given follow-system mode When the system is dark Then the dark class is applied', () => {
    expect(applyTheme(new Map([['snap-theme-mode', 'system']]), true)).toEqual(['dark'])
  })
})
