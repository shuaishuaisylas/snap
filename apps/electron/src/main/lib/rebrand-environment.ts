/** Snap 独立发行版只读取自己的启动变量，不转换别名或改写进程环境。 */
export interface SnapStartupEnvironment {
  development: boolean
  instance: string | undefined
}

export function readSnapEnvironment(environment: NodeJS.ProcessEnv): SnapStartupEnvironment {
  const instance = environment.SNAP_DEV_INSTANCE?.replace(/[^a-zA-Z0-9_-]/g, '')
  return {
    development: environment.SNAP_DEV === '1',
    instance: instance || undefined,
  }
}
