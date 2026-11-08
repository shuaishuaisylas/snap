'use strict'

const { execFile } = require('node:child_process')
const { createRequire } = require('node:module')
const { isAbsolute, resolve, sep } = require('node:path')
const { promisify } = require('node:util')

const runFile = promisify(execFile)

/**
 * 使用 builder 已有的签名实现，以嵌套代码优先、应用最后的顺序完成 adhoc 签名。
 * 不使用 Developer ID、不嵌入 provisioning profile，也不发起 Apple 公证。
 * @param {{ app: string, platform?: string, binaries?: string[], optionsForFile?: (path: string) => object }} options
 */
module.exports = async function signMacDemo(options) {
  if (process.platform !== 'darwin' || options.platform !== 'darwin') {
    throw new Error('adhoc 签名脚本只允许打包 macOS 桌面演示版')
  }
  const appPath = resolve(options.app)
  if (!isAbsolute(options.app) || !appPath.endsWith('.app')) throw new Error('签名目标不是绝对 .app 路径')
  for (const binary of options.binaries || []) {
    if (!resolve(binary).startsWith(`${appPath}${sep}`)) throw new Error('额外签名目标不在当前应用包内')
  }

  // 从直接构建依赖定位它自身的签名库，不增加应用的运行时依赖。
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
  const { signAsync } = libraryRequire('@electron/osx-sign')
  const existingOptionsForFile = options.optionsForFile
  await signAsync({
    ...options,
    app: appPath,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    provisioningProfile: undefined,
    keychain: undefined,
    // 该签名库会把 true 拼成无效的 --strict=true；undefined 仍启用裸 --strict。
    strictVerify: undefined,
    optionsForFile: (filePath) => ({
      ...(existingOptionsForFile ? existingOptionsForFile(filePath) : {}),
      timestamp: 'none',
    }),
  })

  // 验证完成后才允许 builder 制作 DMG/ZIP；后续 hook 不再改动已签名应用。
  await runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    encoding: 'utf8', timeout: 120_000,
  })
  console.log('[mac-sign] 已完成并验证 adhoc 完整性签名；此版本未作 Developer ID 签名或公证')
}
