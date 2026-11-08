/**
 * Installer Manifest 客户端
 *
 * 独立演示版直接提供固定的官方依赖安装源，不访问其他应用的安装清单服务。
 */

import type { InstallerManifest, InstallerSource } from '@snap/shared'

/**
 * 内置 fallback manifest。
 *
 * 断网或 API 不可达时使用，此时没有 OSS 签名 URL，直接让客户端走 fallbackUrl
 * （官方上游）。sha256 留空，下载器在 sha256 为空时跳过校验并打 warning。
 */
const BUILTIN_FALLBACK: InstallerManifest = {
  installers: [
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'x64',
      version: '2.47.1',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe',
      sha256: '',
      sizeBytes: 66000000,
      filename: 'Git-2.47.1-64-bit.exe',
    },
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'arm64',
      version: '2.47.1',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-arm64.exe',
      sha256: '',
      sizeBytes: 66000000,
      filename: 'Git-2.47.1-arm64.exe',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'x64',
      version: '22.13.1',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-x64.msi',
      sha256: '',
      sizeBytes: 28000000,
      filename: 'node-v22.13.1-x64.msi',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'arm64',
      version: '22.13.1',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-arm64.msi',
      sha256: '',
      sizeBytes: 28000000,
      filename: 'node-v22.13.1-arm64.msi',
    },
  ],
}

/** 兼容现有调用签名；返回独立副本，避免调用方改写共享清单。 */
export async function fetchInstallerManifest(_force = false): Promise<InstallerManifest> {
  return structuredClone(BUILTIN_FALLBACK)
}

/**
 * 从清单中挑出匹配指定 (id, arch) 的条目
 */
export function findInstallerSource(
  manifest: InstallerManifest,
  id: string,
  arch: 'x64' | 'arm64',
): InstallerSource | undefined {
  return manifest.installers.find((s) => s.id === id && s.arch === arch)
}
