'use strict'

const { execFile } = require('node:child_process')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { promisify } = require('node:util')

const runFile = promisify(execFile)

/**
 * 检查随包许可，并在 builder 签名前移除下线权限和扩展属性。
 * @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context
 */
module.exports = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas'
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const resourcesPath = isMac ? join(appPath, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  for (const name of ['LICENSE', 'NOTICE']) {
    const content = await readFile(join(resourcesPath, 'licenses', name), 'utf8')
    if (!content.trim()) throw new Error(`安装包缺少有效的 ${name}，停止打包`)
  }
  if (!isMac) return

  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const options = { encoding: 'utf8', timeout: 10_000 }
  const { stdout } = await runFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath], options)
  const info = JSON.parse(stdout)
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('macOS Info.plist 不是有效字典，未修改权限声明')
  // 路径始终作为参数传入系统工具；不经过 shell，也不重建其他 Info.plist 字段。
  if (Object.prototype.hasOwnProperty.call(info, 'NSMicrophoneUsageDescription')) {
    await runFile('/usr/bin/plutil', ['-remove', 'NSMicrophoneUsageDescription', '--', plistPath], options)
  }
  // Finder 元数据会使 codesign 拒绝签名；这里只处理当前待打包的应用副本。
  await runFile('/usr/bin/xattr', ['-cr', appPath], { encoding: 'utf8', timeout: 120_000 })
}
