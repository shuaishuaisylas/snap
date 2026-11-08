import { expect, test } from 'bun:test'
import { fetchInstallerManifest, findInstallerSource } from './installer-manifest'

test('Given the independent demo When dependency sources are requested Then official sources are returned without any remote manifest call', async () => {
  const originalFetch = globalThis.fetch
  let networkAttempts = 0
  globalThis.fetch = Object.assign(
    async () => { networkAttempts++; throw new Error('Unexpected network call') },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const first = await fetchInstallerManifest()
    const second = await fetchInstallerManifest(true)
    expect(networkAttempts).toBe(0)
    expect(first.installers).toHaveLength(4)
    expect(second).toEqual(first)
    for (const source of first.installers) {
      const url = new URL(source.fallbackUrl!)
      expect(url.protocol).toBe('https:')
      expect(['github.com', 'nodejs.org']).toContain(url.hostname)
    }
    first.installers[0]!.filename = 'caller-mutated.exe'
    expect((await fetchInstallerManifest()).installers[0]!.filename).not.toBe('caller-mutated.exe')
  } finally { globalThis.fetch = originalFetch }
})

test('Given official dependency sources When an item is selected Then id and architecture must both match', async () => {
  const manifest = await fetchInstallerManifest()
  expect(findInstallerSource(manifest, 'nodejs', 'arm64')?.filename).toBe('node-v22.13.1-arm64.msi')
  expect(findInstallerSource(manifest, 'missing-tool', 'x64')).toBeUndefined()
})
