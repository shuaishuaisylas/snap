import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareBrandData, prepareBusinessData } from './rebrand-data-migration'

interface Fixture {
  root: string
  home: string
  appData: string
  outside: string
}

const temporaryRoots: string[] = []

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'snap-data-init-'))
  temporaryRoots.push(root)
  const home = join(root, 'home')
  const appData = join(root, 'app-data')
  const outside = join(root, 'outside')
  for (const directory of [home, appData, outside]) mkdirSync(directory)
  return { root, home, appData, outside }
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, { mode: 0o600 })
}

function directoryLink(source: string, target: string): void {
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Snap 全新独立数据根', () => {
  test('Given 全新正式安装 When 准备启动 Then 返回独立根和固定身份且不提前写资料', () => {
    const { home, appData } = fixture()
    expect(prepareBrandData({ home, appData, isPackaged: true, environment: {} })).toEqual({
      configRoot: join(home, '.snap'), userDataRoot: join(appData, 'Snap'), encryptionIdentity: 'Snap',
    })
    expect(readdirSync(home)).toEqual([])
    expect(readdirSync(appData)).toEqual([])
  })

  test('Given 未打包应用 When 准备启动 Then 业务与浏览器都使用开发根', () => {
    const { home, appData } = fixture()
    expect(prepareBrandData({ home, appData, isPackaged: false, environment: {} })).toEqual({
      configRoot: join(home, '.snap-dev'), userDataRoot: join(appData, '@snap', 'electron-dev'), encryptionIdentity: 'Snap',
    })
  })

  test('Given 正式包显式开启开发模式 When 准备启动 Then 不使用正式浏览器资料', () => {
    const { home, appData } = fixture()
    const result = prepareBrandData({ home, appData, isPackaged: true, environment: { SNAP_DEV: '1' } })
    expect(result.configRoot).toBe(join(home, '.snap-dev'))
    expect(result.userDataRoot).toBe(join(appData, '@snap', 'electron-dev'))
  })

  test('Given 开发实例含路径分隔符 When 准备启动 Then 实例名不能逃出开发资料根', () => {
    const { home, appData } = fixture()
    const result = prepareBrandData({ home, appData, isPackaged: false, environment: { SNAP_DEV_INSTANCE: '../../review/*' } })
    expect(result.userDataRoot).toBe(join(appData, '@snap', 'electron-dev-review'))
    expect(readdirSync(appData)).toEqual([])
  })

  test('Given 已有Snap资料和不透明记录 When 重复启动 Then 保留内容与目录身份且不解析历史标记', () => {
    const { home, appData } = fixture()
    const configRoot = join(home, '.snap')
    const userDataRoot = join(appData, 'Snap')
    write(join(configRoot, 'user-profile.json'), '{"name":"Snap user"}')
    write(join(configRoot, 'channels.json'), 'opaque encrypted bytes')
    write(join(configRoot, '.snap-migration.json'), '{not a configuration document')
    write(join(userDataRoot, 'Local State'), 'opaque browser state')
    const configInode = lstatSync(configRoot).ino
    const browserInode = lstatSync(userDataRoot).ino
    const options = { home, appData, isPackaged: true, environment: {} }
    const first = prepareBrandData(options)
    expect(prepareBrandData(options)).toEqual(first)
    expect(prepareBusinessData(home, false, {})).toBe(configRoot)
    expect(readFileSync(join(configRoot, 'channels.json'), 'utf8')).toBe('opaque encrypted bytes')
    expect(readFileSync(join(configRoot, '.snap-migration.json'), 'utf8')).toBe('{not a configuration document')
    expect(readFileSync(join(userDataRoot, 'Local State'), 'utf8')).toBe('opaque browser state')
    expect(lstatSync(configRoot).ino).toBe(configInode)
    expect(lstatSync(userDataRoot).ino).toBe(browserInode)
  })

  test.each([false, true])('Given CLI dev=%s When 准备业务根 Then 与桌面所选根一致', (dev) => {
    const { home, appData } = fixture()
    const desktop = prepareBrandData({ home, appData, isPackaged: !dev, environment: {} })
    expect(prepareBusinessData(home, dev, {})).toBe(desktop.configRoot)
    expect(existsSync(desktop.configRoot)).toBe(false)
  })

  test('Given 外部资料、活动锁及环境中的导入诱导 When 初始化 Then 不读取导入配置或其他目录内容', () => {
    const { home, appData, outside } = fixture()
    write(join(outside, 'account.json'), 'external account must stay external')
    const unrelated = join(home, '.other-client')
    directoryLink(outside, unrelated)
    write(join(appData, 'OtherClient', 'Local State'), 'external browser')
    symlinkSync(`fixture-host-${process.pid}`, join(appData, 'OtherClient', 'SingletonLock'))
    const environment: NodeJS.ProcessEnv = {}
    for (const name of ['SNAP_IMPORT_LEGACY_DATA', 'SNAP_ENCRYPTION_IDENTITY', 'APPDATA', 'XDG_CONFIG_HOME']) {
      Object.defineProperty(environment, name, { get: () => { throw new Error(`不应读取 ${name}`) } })
    }
    const result = prepareBrandData({ home, appData, isPackaged: true, environment })
    expect(result.encryptionIdentity).toBe('Snap')
    expect(prepareBusinessData(home, false, environment)).toBe(join(home, '.snap'))
    expect(readdirSync(home)).toEqual(['.other-client'])
    expect(readdirSync(appData)).toEqual(['OtherClient'])
    expect(readFileSync(join(outside, 'account.json'), 'utf8')).toBe('external account must stay external')
    expect(readlinkSync(unrelated)).toBe(outside)
  })

  test('Given Snap根内含外部文件链接 When 仅准备资料根 Then 不读取或改写链接目标', () => {
    const { home, appData, outside } = fixture()
    const configRoot = join(home, '.snap')
    mkdirSync(configRoot)
    symlinkSync(join(outside, 'missing-private-file'), join(configRoot, 'channels.json'))
    expect(prepareBrandData({ home, appData, isPackaged: true, environment: {} }).configRoot).toBe(configRoot)
    expect(readlinkSync(join(configRoot, 'channels.json'))).toBe(join(outside, 'missing-private-file'))
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('Snap 数据根必须为真实目录', () => {
  test('Given 业务根是外部目录链接 When GUI或CLI准备启动 Then 拒绝且不覆盖外部资料', () => {
    const { home, appData, outside } = fixture()
    write(join(outside, 'account.json'), 'keep original')
    directoryLink(outside, join(home, '.snap'))
    expect(() => prepareBrandData({ home, appData, isPackaged: true, environment: {} })).toThrow('必须为真实目录')
    expect(() => prepareBusinessData(home, false, {})).toThrow('必须为真实目录')
    expect(readFileSync(join(outside, 'account.json'), 'utf8')).toBe('keep original')
    expect(existsSync(join(appData, 'Snap'))).toBe(false)
  })

  test('Given 业务根是悬空链接 When 准备启动 Then 不把链接误判为未创建目录', () => {
    const { home, outside } = fixture()
    directoryLink(join(outside, 'missing'), join(home, '.snap'))
    expect(() => prepareBusinessData(home, false, {})).toThrow('必须为真实目录')
    expect(lstatSync(join(home, '.snap')).isSymbolicLink()).toBe(true)
  })

  test.each([false, true])('Given dev=%s的业务根是文件 When 准备启动 Then 拒绝且保留文件', (dev) => {
    const { home } = fixture()
    const configRoot = join(home, dev ? '.snap-dev' : '.snap')
    write(configRoot, 'existing file')
    expect(() => prepareBusinessData(home, dev, {})).toThrow('必须为真实目录')
    expect(readFileSync(configRoot, 'utf8')).toBe('existing file')
  })

  test('Given 浏览器根是外部链接 When GUI准备启动 Then 预检拒绝且不先创建业务根', () => {
    const { home, appData, outside } = fixture()
    directoryLink(outside, join(appData, 'Snap'))
    expect(() => prepareBrandData({ home, appData, isPackaged: true, environment: {} })).toThrow('必须为真实目录')
    expect(existsSync(join(home, '.snap'))).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })

  test('Given 开发目录的中间节点是外部链接 When 准备实例 Then 不经链接访问目标', () => {
    const { home, appData, outside } = fixture()
    mkdirSync(join(outside, 'electron-dev-preview'))
    directoryLink(outside, join(appData, '@snap'))
    expect(() => prepareBrandData({ home, appData, isPackaged: false, environment: { SNAP_DEV_INSTANCE: 'preview' } })).toThrow('必须为真实目录')
    expect(existsSync(join(home, '.snap-dev'))).toBe(false)
    expect(readdirSync(outside)).toEqual(['electron-dev-preview'])
  })

  test('Given 开发实例根是外部链接 When 准备启动 Then 拒绝使用链接位置', () => {
    const { home, appData, outside } = fixture()
    mkdirSync(join(appData, '@snap'))
    directoryLink(outside, join(appData, '@snap', 'electron-dev-preview'))
    expect(() => prepareBrandData({ home, appData, isPackaged: false, environment: { SNAP_DEV_INSTANCE: 'preview' } })).toThrow('必须为真实目录')
  })

  test('Given 主目录参数本身是链接 When 准备业务根 Then 不创建外部根', () => {
    const { root, appData, outside } = fixture()
    const linkedHome = join(root, 'linked-home')
    directoryLink(outside, linkedHome)
    expect(() => prepareBrandData({ home: linkedHome, appData, isPackaged: true, environment: {} })).toThrow('必须为真实目录')
    expect(readdirSync(outside)).toEqual([])
  })

  test('Given 浏览器基础目录本身是链接 When 准备启动 Then 不创建外部浏览器根', () => {
    const { root, home, outside } = fixture()
    const linkedAppData = join(root, 'linked-app-data')
    directoryLink(outside, linkedAppData)
    expect(() => prepareBrandData({ home, appData: linkedAppData, isPackaged: true, environment: {} })).toThrow('必须为真实目录')
    expect(readdirSync(outside)).toEqual([])
  })
})
