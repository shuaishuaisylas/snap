import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface PackContext {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

interface PackFixture {
  context: PackContext
  plistPath: string
  licenseDirectory: string
}

const afterPack = createRequire(import.meta.url)('./after-pack.cjs') as (context: PackContext) => Promise<void>
const macTest = process.platform === 'darwin' ? test : test.skip
const temporaryRoots: string[] = []

function fixture(withMicrophone = true, electronPlatformName = 'darwin'): PackFixture {
  const appOutDir = mkdtempSync(join(tmpdir(), 'snap-after-pack-'))
  temporaryRoots.push(appOutDir)
  // 空格、引号与 shell 字符必须作为普通路径处理。
  const productFilename = "Snap test '$(not-a-command)"
  const contentsPath = join(appOutDir, `${productFilename}.app`, 'Contents')
  const plistPath = join(contentsPath, 'Info.plist')
  const resourcesPath = ['darwin', 'mas'].includes(electronPlatformName)
    ? join(contentsPath, 'Resources')
    : join(appOutDir, 'resources')
  const licenseDirectory = join(resourcesPath, 'licenses')
  mkdirSync(licenseDirectory, { recursive: true })
  writeFileSync(join(licenseDirectory, 'LICENSE'), '许可正文 fixture\n')
  writeFileSync(join(licenseDirectory, 'NOTICE'), '来源说明 fixture\n')
  mkdirSync(join(plistPath, '..'), { recursive: true })
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Snap</string>
${withMicrophone ? '<key>NSMicrophoneUsageDescription</key><string>This app needs access to the microphone</string>' : ''}
<key>NSCalendarsFullAccessUsageDescription</key><string>保留日历权限</string>
<key>NSRemindersFullAccessUsageDescription</key><string>保留提醒事项权限</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`)
  return { context: { electronPlatformName, appOutDir, packager: { appInfo: { productFilename } } }, plistPath, licenseDirectory }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('最终macOS包的已移除麦克风权限', () => {
  macTest('Given Electron继承的麦克风声明和日历权限 When afterPack处理真实临时plist Then 仅删除麦克风且幂等', async () => {
    const { context, plistPath } = fixture()
    await afterPack(context)
    const info: unknown = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath], { encoding: 'utf8' }))
    expect(info).toEqual({
      CFBundleName: 'Snap',
      NSCalendarsFullAccessUsageDescription: '保留日历权限',
      NSRemindersFullAccessUsageDescription: '保留提醒事项权限',
      LSUIElement: true,
    })
    const once = readFileSync(plistPath)
    await afterPack(context)
    expect(readFileSync(plistPath)).toEqual(once)
  })

  macTest('Given 麦克风声明已经不存在 When afterPack执行 Then 原plist字节不改写', async () => {
    const { context, plistPath } = fixture(false)
    const before = readFileSync(plistPath)
    await afterPack(context)
    expect(readFileSync(plistPath)).toEqual(before)
  })

  test.each(['win32', 'linux'])('Given %s平台及其resources许可 When afterPack执行 Then 仅核对许可且不读取或修改mac plist', async (platform) => {
    const { context, plistPath, licenseDirectory } = fixture(true, platform)
    // 若误走 macOS 的 plutil 路径，这份无效 plist 会使测试失败。
    writeFileSync(plistPath, 'non-mac plist must not be read')
    const before = readFileSync(plistPath)
    const licenseBefore = readFileSync(join(licenseDirectory, 'LICENSE'))
    const noticeBefore = readFileSync(join(licenseDirectory, 'NOTICE'))
    await afterPack(context)
    expect(readFileSync(plistPath)).toEqual(before)
    expect(readFileSync(join(licenseDirectory, 'LICENSE'))).toEqual(licenseBefore)
    expect(readFileSync(join(licenseDirectory, 'NOTICE'))).toEqual(noticeBefore)
  })

  macTest('Given 损坏plist When afterPack执行 Then 阻止继续打包且不重写原文件', async () => {
    const { context, plistPath } = fixture()
    writeFileSync(plistPath, 'invalid plist fixture')
    await expect(afterPack(context)).rejects.toThrow()
    expect(readFileSync(plistPath, 'utf8')).toBe('invalid plist fixture')
  })
})

describe('安装包许可与来源文件', () => {
  for (const platform of ['darwin', 'mas', 'win32', 'linux']) {
    test.each(['LICENSE', 'NOTICE'])(`Given ${platform}包缺少%s When afterPack执行 Then 拒绝继续且未修改权限文件`, async (name) => {
      const { context, plistPath, licenseDirectory } = fixture(true, platform)
      const before = readFileSync(plistPath)
      rmSync(join(licenseDirectory, name))
      await expect(afterPack(context)).rejects.toThrow(name)
      expect(readFileSync(plistPath)).toEqual(before)
    })
  }

  test.each(['LICENSE', 'NOTICE'])('Given %s只有空白内容 When afterPack执行 Then 明确拒绝打包并保留plist', async (name) => {
    const { context, plistPath, licenseDirectory } = fixture()
    const before = readFileSync(plistPath)
    writeFileSync(join(licenseDirectory, name), ' \n\t')
    await expect(afterPack(context)).rejects.toThrow(`安装包缺少有效的 ${name}，停止打包`)
    expect(readFileSync(plistPath)).toEqual(before)
  })
})
