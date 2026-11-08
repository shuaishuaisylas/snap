const SOURCE_URL = 'https://github.com/shuaishuaisylas/snap'
// 独立演示版使用自己的请求身份；订阅渠道是否接受该身份须分别验证。
const PROVIDER_IDENTITY = 'Snap'

let _snapVersion = '0.0.0'

export function setSnapVersion(version: string): void {
  _snapVersion = version
}

export function getSnapVersion(): string {
  return _snapVersion
}

export function getSnapUserAgent(version?: string): string {
  const v = version ?? _snapVersion
  return `${PROVIDER_IDENTITY}/${v} (+${SOURCE_URL})`
}
