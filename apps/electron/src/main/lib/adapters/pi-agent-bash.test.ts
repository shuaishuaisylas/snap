import { describe, expect, test } from 'bun:test'
import { buildWslBashArgs, windowsPathToWslPath } from './pi-agent-adapter'

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

  test('Given the Snap CLI variable When exported into WSL Then it appears once with its Linux path', () => {
    const cli = 'C:\\Snap\\bin\\snap.exe'
    const args = buildWslBashArgs({}, 'C:\\Work', '"$SNAP_CLI" session list', {
      SNAP_CLI: cli,
    })
    expect(args.at(-1)).toBe('export SNAP_CLI=\'/mnt/c/Snap/bin/snap.exe\'\n"$SNAP_CLI" session list')
  })

})
