import { describe, expect, test } from 'bun:test'
import { BROWSER_RISK_DISCLAIMER_VERSION } from '../../types/settings'
import { hasAcknowledgedBrowserRiskDisclaimer } from './browser-risk-disclaimer'

describe('Ego Lite 账号范围的版本化确认', () => {
  test('Given 未确认或旧内嵌浏览器的版本 1 确认 When 检查当前账号范围 Then 必须重新确认', () => {
    expect(BROWSER_RISK_DISCLAIMER_VERSION).toBe(2)
    expect(hasAcknowledgedBrowserRiskDisclaimer({})).toBe(false)
    expect(hasAcknowledgedBrowserRiskDisclaimer({ browserRiskDisclaimerVersion: 1 })).toBe(false)
  })

  test('Given 已确认当前告知版本 When 检查门禁 Then 允许当前 Ego Lite 使用范围', () => {
    expect(hasAcknowledgedBrowserRiskDisclaimer({ browserRiskDisclaimerVersion: BROWSER_RISK_DISCLAIMER_VERSION })).toBe(true)
  })
})
