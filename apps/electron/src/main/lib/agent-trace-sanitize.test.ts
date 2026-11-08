import { describe, expect, test } from 'bun:test'
import type { AgentTraceEvent } from '@snap/shared'
import { sanitizeAgentTraceEvent } from './agent-trace-sanitize'

const MAX_TRACE_CHARS = 192 * 1024
const ARTIFACT = '/synthetic/pi/sessions/example.jsonl'

function fixture(payload: Partial<AgentTraceEvent> = {}): AgentTraceEvent {
  return { id: 'event-1', sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
    kind: 'tool', name: 'Read', status: 'completed', source: 'live',
    startedAt: 1000, endedAt: 1015, durationMs: 15, ...payload }
}

describe('Agent 轨迹的脱敏与总量限制', () => {
  test('Given 后台说明含凭据或极长文本 When 保存 Then 说明同样脱敏且保持有界', () => {
    const explanation = { text: '为了检查配置 api_key="fake-summary-secret" ' + '字'.repeat(4_000),
      source: 'model' as const, status: 'ready' as const, version: 1 }
    const result = sanitizeAgentTraceEvent(fixture({ explanation }))
    expect(result.explanation?.text).not.toContain('fake-summary-secret')
    expect(result.explanation!.text.length).toBeLessThanOrEqual(800)
    expect(result.explanation?.source).toBe('model')
    expect(explanation.text).toContain('fake-summary-secret')
  })
  test('Given 正常上下文和工具结果 When 脱敏 Then 保留身份、时间与普通字段且不修改源对象', () => {
    const original = fixture({ input: { file: 'example.json' }, output: { text: '普通内容', count: 3 },
      metadata: { artifactFile: ARTIFACT, usage: { input: 12, output: 3 } } })
    const result = sanitizeAgentTraceEvent(original)
    expect(result).toEqual(original)
    expect(result).not.toBe(original)
    expect(result.input).not.toBe(original.input)
    expect(result.metadata?.truncated).toBeUndefined()
  })

  test('Given 结构化认证字段和环境变量名 When 保存 Then 不记录凭据值', () => {
    const result = sanitizeAgentTraceEvent(fixture({ input: { apiKey: 'fake-key-123',
      OPENAI_API_KEY: 'fake-env-key-123', headers: { Authorization: 'Bearer fake-abc',
        Cookie: 'session=fake-session', 'X-Api-Key': 'fake-header-key' },
      normal: 'diagnostic' } }))
    const json = JSON.stringify(result)
    for (const secret of ['fake-key-123', 'fake-env-key-123', 'fake-abc', 'fake-session', 'fake-header-key']) {
      expect(json).not.toContain(secret)
    }
    expect(json).toContain('diagnostic')
  })

  test('Given 工具输出中的 JSON 凭据与带引号环境值 When 保存 Then 整个值隐藏且普通诊断仍在', () => {
    const result = sanitizeAgentTraceEvent(fixture({ output:
      '{"password": "fake-password-123", "api_key": "fake-key-123", "count": 8}\n'
      + 'DEEPSEEK_API_KEY="fake env value 123"\nclient_secret=fake-client-secret\nplain=kept',
    }))
    const text = String(result.output)
    for (const secret of ['fake-password-123', 'fake-key-123', 'fake env value 123', 'fake-client-secret']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('"count": 8')
    expect(text).toContain('plain=kept')
  })

  test('Given HTTP头和含账号认证或查询token的URL When 保存 Then 隐藏常见认证信息', () => {
    const result = sanitizeAgentTraceEvent(fixture({ output:
      'Cookie: session=fake-cookie-one; other=fake-cookie-two\n'
      + 'Authorization: Basic ZmFrZS1iYXNpYw==\n'
      + 'https://fake-user:fake-url-password@example.test/path?access_token=fake-query-token&count=3\n'
      + 'Bearer fake-bearer-token\nsk-fake_long_key_1234567890',
    }))
    const text = String(result.output)
    for (const secret of ['fake-cookie-one', 'fake-cookie-two', 'ZmFrZS1iYXNpYw', 'fake-user',
      'fake-url-password', 'fake-query-token', 'fake-bearer-token', 'sk-fake_long_key_1234567890']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('example.test/path?access_token=')
    expect(text).toContain('&count=3')
  })

  test('Given 普通URL中的邮箱和工具结果伪装的artifact字段 When 保存 Then 只保留真实关联元数据的路径特例', () => {
    const ordinary = 'https://example.test?contact=user@example.test'
    const result = sanitizeAgentTraceEvent(fixture({
      output: { url: ordinary, artifactFile: 'https://fake-user:fake-password@example.test/path' },
      metadata: { artifactFile: ARTIFACT },
    }))
    expect((result.output as Record<string, unknown>).url).toBe(ordinary)
    expect(JSON.stringify(result.output)).not.toContain('fake-password')
    expect(result.metadata?.artifactFile).toBe(ARTIFACT)
  })

  test('Given 很大的纯数字结果 When 限流 Then JSON总字符有界且标注截断', () => {
    const output = Array.from({ length: 200 }, () => Array.from({ length: 200 }, () => 1234567890))
    const result = sanitizeAgentTraceEvent(fixture({ output, metadata: { artifactFile: ARTIFACT } }))
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_TRACE_CHARS)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.metadata?.artifactFile).toBe(ARTIFACT)
  })

  test('Given 大量对象键与需转义文本 When 限流 Then 键、标点和JSON转义均计入预算', () => {
    const fields = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`${index}-${'k'.repeat(3000)}`, true]))
    const result = sanitizeAgentTraceEvent(fixture({ input: fields,
      output: ['\u0000\\"'.repeat(100000), 'ordinary'], metadata: { artifactFile: ARTIFACT } }))
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_TRACE_CHARS)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.metadata?.artifactFile).toBe(ARTIFACT)
    const escaped = sanitizeAgentTraceEvent(fixture({ output: '\u0000\\"'.repeat(100000) }))
    expect(JSON.stringify(escaped).length).toBeLessThanOrEqual(MAX_TRACE_CHARS)
    expect(String(escaped.output)).toContain('[内容已截断]')
  })

  test('Given 非循环的共享工具定义 When input和schema同时引用 Then 两边均可查看完整定义', () => {
    const tool = { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
    const result = sanitizeAgentTraceEvent(fixture({ input: { toolsAdded: [tool] }, schema: [tool] }))
    expect(result.schema).toEqual([tool])
    expect(JSON.stringify(result)).not.toContain('[循环引用]')
  })

  test('Given 真正循环结构与图片内容 When 保存 Then 循环有界且图片仅保留说明', () => {
    const cyclic: Record<string, unknown> = { text: 'ordinary' }
    cyclic.self = cyclic
    const result = sanitizeAgentTraceEvent(fixture({ input: cyclic,
      output: [{ type: 'image', mimeType: 'image/png', data: 'fake-binary-payload' }, undefined, { text: 'after-image' }],
    }))
    expect(JSON.stringify(result.input)).toContain('[循环引用]')
    expect(result.output).toEqual([{ type: 'image', mimeType: 'image/png', note: '图片二进制不进入轨迹' }, null, { text: 'after-image' }])
    expect(JSON.stringify(result)).not.toContain('fake-binary-payload')
  })
})
