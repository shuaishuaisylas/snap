import { describe, expect, test } from 'bun:test'
import type { GitBashStatus, RuntimeStatus, ShellEnvironmentStatus, WslStatus } from '@snap/shared'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'

function runtimeStatus(shell: ShellEnvironmentStatus): RuntimeStatus {
  return { shell } as RuntimeStatus
}

const gitBash: GitBashStatus = {
  available: true,
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  version: '5.2.37',
  error: null,
}

const wsl: WslStatus = {
  available: true,
  version: 2,
  defaultDistro: 'Ubuntu-24.04',
  distros: ['Ubuntu-24.04'],
  error: null,
}

const bothShells = runtimeStatus({ gitBash, wsl, recommended: 'git-bash' })

describe('Agent Windows Shell 运行环境', () => {
  test('Given Snap CLI路径 When 构造Agent子进程环境 Then 仅注入当前命令且不修改父进程环境', () => {
    const processEnv = { PATH: '/usr/bin', SNAP_CLI: '/old/snap' }
    const runtime = buildAgentRuntimeEnv({
      bundledCliPath: '/fixture/bin/snap', platform: 'darwin', pathDelimiter: ':', processEnv,
    })
    expect(runtime.env.SNAP_CLI).toBe('/fixture/bin/snap')
    expect(runtime.env.PATH).toBe('/fixture/bin:/usr/bin')
    expect(mergeRuntimeEnv({ ...processEnv, snap_cli: '/another/stale' }, runtime.env)).toEqual({
      PATH: '/fixture/bin:/usr/bin', SNAP_CLI: '/fixture/bin/snap',
    })
    expect(processEnv.SNAP_CLI).toBe('/old/snap')
  })

  test('Given Git Bash 与 WSL 均可用 When 使用默认策略 Then 优先使用 Git Bash', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      runtimeStatus: bothShells,
    })

    expect(result).toMatchObject({
      shellKind: 'git-bash',
      shellPath: gitBash.path,
      env: {
        SNAP_WINDOWS_SHELL: 'git-bash',
      },
    })
  })

  test('Given Git Bash 与 WSL 均可用 When 用户显式选择 WSL Then 使用 WSL', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      runtimeStatus: bothShells,
      windowsShellPreference: 'wsl',
    })

    expect(result).toMatchObject({
      shellKind: 'wsl',
      wslCommand: 'wsl.exe',
      wslDistro: 'Ubuntu-24.04',
      env: {
        SNAP_WINDOWS_SHELL: 'wsl',
        SNAP_WSL_DISTRO: 'Ubuntu-24.04',
      },
    })
  })

  test('Given WSL 首选项不可用 When Git Bash 可用 Then 回退到 Git Bash', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      windowsShellPreference: 'wsl',
      runtimeStatus: runtimeStatus({
        gitBash,
        wsl: { ...wsl, available: false, version: null, defaultDistro: null, distros: [], error: '未安装' },
        recommended: 'git-bash',
      }),
    })

    expect(result.shellKind).toBe('git-bash')
    expect(result.shellPath).toBe(gitBash.path!)
  })

  test('Given Windows Path 大小写不同 When 合并运行环境 Then 仅保留覆盖后的 PATH', () => {
    const result = mergeRuntimeEnv(
      { Path: 'C:\\Windows\\System32' },
      { PATH: 'C:\\Snap;C:\\Windows\\System32' },
    )

    expect(result).toEqual({ PATH: 'C:\\Snap;C:\\Windows\\System32' })
  })
})
