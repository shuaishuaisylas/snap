import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EgoLitePreviewServer } from './ego-lite-preview'

let directory = ''
let preview: EgoLitePreviewServer
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'snap-ego-preview-'))
  mkdirSync(join(directory, 'project'))
  writeFileSync(join(directory, 'project/index.html'), '<h1>本地预览</h1><link rel="stylesheet" href="style.css">')
  writeFileSync(join(directory, 'project/style.css'), 'h1 { color: red }')
  writeFileSync(join(directory, 'outside.html'), '不可外泄的文件')
  preview = new EgoLitePreviewServer()
})
afterEach(() => { preview.dispose(); rmSync(directory, { recursive: true, force: true }) })

describe('Ego 本地 HTML 受限预览服务', () => {
  test('Given 授权 HTML 及旁边资源 When 注册并读取 Then 通过随机 token 的 loopback URL 提供内容', async () => {
    const url = await preview.register('session', join(directory, 'project'), [join(directory, 'project')])
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/index\.html$/)
    const html = await fetch(url)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('本地预览')
    expect(html.headers.get('referrer-policy')).toBe('no-referrer')
    const asset = await fetch(new URL('style.css', url))
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('color: red')
  })

  test('Given 根外文件或跨目录符号链接 When 注册或请求 Then 拒绝越权读取', async () => {
    await expect(preview.register('session', join(directory, 'outside.html'), [join(directory, 'project')])).rejects.toThrow('已授权')
    symlinkSync(join(directory, 'outside.html'), join(directory, 'project/leak.html'))
    const url = await preview.register('session', join(directory, 'project'), [join(directory, 'project')])
    expect((await fetch(new URL('leak.html', url))).status).toBe(403)
    expect((await fetch(new URL('style.css', url), { method: 'POST' })).status).toBe(405)
    expect((await fetch(url.replace(/\/[a-f0-9]{48}\//, '/invalid/'))).status).toBe(404)
  })

  test('Given token 仍可用 When 会话关闭撤销 Then 已知 URL 也无法继续读取', async () => {
    const url = await preview.register('session', join(directory, 'project/index.html'), [join(directory, 'project')])
    preview.revokeSession('session')
    expect((await fetch(url)).status).toBe(404)
  })
})
