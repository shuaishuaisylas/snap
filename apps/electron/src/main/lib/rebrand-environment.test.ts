import { describe, expect, test } from 'bun:test'
import { readSnapEnvironment } from './rebrand-environment'

describe('Snap 原生启动环境', () => {
  test('Given 没有启动变量 When 读取 Then 使用正式默认值且没有实例后缀', () => {
    expect(readSnapEnvironment({})).toEqual({ development: false, instance: undefined })
  })

  test('Given 明确开发变量 When 读取 Then 返回开发模式和安全实例名', () => {
    expect(readSnapEnvironment({ SNAP_DEV: '1', SNAP_DEV_INSTANCE: 'review_1' })).toEqual({ development: true, instance: 'review_1' })
  })

  test.each(['0', 'true', ''])('Given SNAP_DEV=%s When 读取 Then 不隐式开启开发模式', (value) => {
    expect(readSnapEnvironment({ SNAP_DEV: value }).development).toBe(false)
  })

  test('Given 实例名只有路径字符 When 读取 Then 不创建空实例后缀', () => {
    expect(readSnapEnvironment({ SNAP_DEV_INSTANCE: '../*' }).instance).toBeUndefined()
  })

  test('Given 冻结的环境对象 When 读取 Then 不增加、删除或覆盖环境变量', () => {
    const environment = Object.freeze({ SNAP_DEV: '1', SNAP_DEV_INSTANCE: '../review', UNRELATED_SETTING: 'keep' })
    expect(readSnapEnvironment(environment)).toEqual({ development: true, instance: 'review' })
    expect(environment).toEqual({ SNAP_DEV: '1', SNAP_DEV_INSTANCE: '../review', UNRELATED_SETTING: 'keep' })
  })

  test('Given 其他应用的变量和不可读取的导入设置 When 读取 Then 不枚举或转换别名', () => {
    const environment: NodeJS.ProcessEnv = { OTHER_DEV: '1', OTHER_DEV_INSTANCE: 'outside' }
    for (const name of ['SNAP_IMPORT_LEGACY_DATA', 'SNAP_ENCRYPTION_IDENTITY', 'UNRELATED_SETTING']) {
      Object.defineProperty(environment, name, { enumerable: true, get: () => { throw new Error(`不应读取 ${name}`) } })
    }
    expect(readSnapEnvironment(environment)).toEqual({ development: false, instance: undefined })
    expect(environment.OTHER_DEV).toBe('1')
    expect(environment.OTHER_DEV_INSTANCE).toBe('outside')
  })
})
