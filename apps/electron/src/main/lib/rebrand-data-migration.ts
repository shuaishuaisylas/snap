/**
 * 独立发行版的数据根准备：仅解析和校验 Snap 自己的目录。
 * 具体目录由 Electron 或配置服务按需创建；这里不导入、遍历或改写任何资料。
 */
import { lstatSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { readSnapEnvironment } from './rebrand-environment'

export interface SnapDataOptions {
  home: string
  appData: string
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
}

export interface SnapDataRoots {
  configRoot: string
  userDataRoot: string
  encryptionIdentity: string
}

function assertDirectoryOrMissing(path: string): boolean {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Snap 数据目录必须为真实目录，不能是文件或符号链接：${path}`)
    }
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** 按父目录到子目录的顺序检查，避免经由开发实例的中间链接访问其他位置。 */
function validateOwnDataRoot(base: string, target: string): void {
  const baseRoot = resolve(base)
  const suffix = relative(baseRoot, target)
  if (suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Snap 数据目录不能超出指定根')
  if (!assertDirectoryOrMissing(baseRoot)) return
  let current = baseRoot
  for (const segment of suffix.split(sep).filter(Boolean)) {
    current = join(current, segment)
    if (!assertDirectoryOrMissing(current)) return
  }
}

/** 在 Electron 初始化 Chromium 与安全存储前调用，安全存储身份固定为 Snap。 */
export function prepareBrandData(options: SnapDataOptions): SnapDataRoots {
  const environment = readSnapEnvironment(options.environment)
  const development = environment.development || !options.isPackaged
  const configRoot = resolve(options.home, development ? '.snap-dev' : '.snap')
  const userDataRoot = development
    ? resolve(options.appData, '@snap', environment.instance ? `electron-dev-${environment.instance}` : 'electron-dev')
    : resolve(options.appData, 'Snap')
  validateOwnDataRoot(options.home, configRoot)
  validateOwnDataRoot(options.appData, userDataRoot)
  return { configRoot, userDataRoot, encryptionIdentity: 'Snap' }
}

/** CLI 与桌面使用相同的业务资料根；第三个参数保留现有调用形状，不读取导入开关。 */
export function prepareBusinessData(home: string, dev: boolean, _environment: NodeJS.ProcessEnv): string {
  const configRoot = resolve(home, dev ? '.snap-dev' : '.snap')
  validateOwnDataRoot(home, configRoot)
  return configRoot
}
