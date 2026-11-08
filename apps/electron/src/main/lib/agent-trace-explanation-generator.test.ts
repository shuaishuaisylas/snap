import { describe, expect, test } from 'bun:test'
import { getAdapter } from '@snap/core'
import type { Channel, ProviderType } from '@snap/shared'
import {
  buildTraceExplanationRequest,
  createTraceExplanationBatchGenerator,
  parseVisibleTraceExplanationText,
  type TraceExplanationBatchInput,
  type TraceExplanationGeneratorDependencies,
} from './agent-trace-explanation-generator'

function channel(provider: ProviderType = 'deepseek'): Channel {
  return { id: 'fixture-channel', name: '离线渠道', provider, baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'encrypted-fixture', models: [{ id: 'fixture-model', name: '离线模型', enabled: true }],
    enabled: true, createdAt: 1, updatedAt: 1 }
}
function input(signal = new AbortController().signal): TraceExplanationBatchInput {
  return { channelId: 'fixture-channel', modelId: 'fixture-model', prompt: '只解释给定的离线步骤', signal }
}
function dependencies(overrides: Partial<TraceExplanationGeneratorDependencies> = {}): TraceExplanationGeneratorDependencies {
  return { getChannel: () => channel(), resolveApiKey: async () => 'fake-key', getAdapter,
    getProxyUrl: async () => undefined,
    createFetch: () => ({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"id":"one","purpose":"离线解释"}]' } }] })), close: async () => undefined }),
    ...overrides }
}

describe('轨迹后台解释的独立文本生成边界', () => {
  test('Given 模型已禁用或不在当前渠道 When 后台补说明 Then 不发请求', async () => {
    let requests = 0
    const generate = createTraceExplanationBatchGenerator(dependencies({ createFetch: () => ({
      fetch: async () => { requests += 1; return new Response('{}') }, close: async () => undefined,
    }) }))
    expect(await generate({ ...input(), modelId: 'another-model' })).toBeNull()
    expect(requests).toBe(0)
  })
  test('Given 现有不同供应商的标题builder When 用于批量解释 Then 只覆盖输出预算并保留单条独立输入', () => {
    for (const provider of ['openai', 'openai-responses', 'anthropic', 'google'] as const) {
      const adapter = getAdapter(provider)
      const request = adapter.buildTitleRequest({ baseUrl: 'https://fixture.invalid', apiKey: 'fake-key',
        modelId: 'fixture-model', prompt: 'batch-prompt' })
      const original = JSON.parse(request.body) as Record<string, unknown>
      const built = buildTraceExplanationRequest(request)
      const body = JSON.parse(built.body) as Record<string, unknown>
      const config = body.generationConfig as Record<string, unknown> | undefined
      expect(body.max_output_tokens ?? config?.maxOutputTokens ?? body.max_tokens).toBe(768)
      expect(JSON.stringify(body)).toContain('batch-prompt')
      expect(body.tools).toBeUndefined()
      expect(body.previous_response_id).toBeUndefined()
      expect(request.body).toBe(JSON.stringify(original))
      expect(built.headers).toBe(request.headers)
    }
  })

  test('Given 可见正文和思考或工具内容并存 When 读取不同协议 Then 仅返回可见正文', () => {
    expect(parseVisibleTraceExplanationText({ choices: [{ message: { content: [
      { type: 'thinking', text: 'hidden-reasoning' }, { type: 'text', text: 'visible' },
      { type: 'toolCall', text: 'hidden-tool' },
    ], reasoning_content: 'hidden-reasoning' } }] })).toBe('visible')
    expect(parseVisibleTraceExplanationText({ content: [{ type: 'thinking', thinking: 'hidden' }] })).toBeNull()
    expect(parseVisibleTraceExplanationText({ output: [
      { type: 'reasoning', content: [{ type: 'text', text: 'hidden' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'visible-response' }] },
    ] })).toBe('visible-response')
    expect(parseVisibleTraceExplanationText({ candidates: [{ content: { parts: [
      { text: 'hidden', thought: true }, { text: 'visible-google' },
    ] } }] })).toBe('visible-google')
    expect(parseVisibleTraceExplanationText({ error: 'hidden-error', reasoning: 'hidden-reasoning' })).toBeNull()
  })

  test('Given 普通渠道 When 生成 Then 单次请求使用外部可取消signal且释放代理资源', async () => {
    let calls = 0
    let closes = 0
    let requestBody: Record<string, unknown> = {}
    let requestSignal: AbortSignal | null | undefined
    const generate = createTraceExplanationBatchGenerator(dependencies({
      createFetch: () => ({ fetch: async (_url, init) => {
        calls += 1
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        requestSignal = init?.signal
        return new Response(JSON.stringify({ choices: [{ message: { content: '[{"id":"one","purpose":"离线解释"}]' } }] }))
      }, close: async () => { closes += 1 } }),
    }))
    const result = await generate(input())
    expect(result).toBe('[{"id":"one","purpose":"离线解释"}]')
    expect(calls).toBe(1)
    expect(closes).toBe(1)
    expect(requestSignal).toBeInstanceOf(AbortSignal)
    expect(requestSignal?.aborted).toBe(false)
    expect(requestBody.max_tokens).toBe(768)
    expect(requestBody.messages).toEqual([{ role: 'user', content: '只解释给定的离线步骤' }])
  })

  test('Given 非2xx或畸形响应 When 生成 Then 不重试且回退为空', async () => {
    for (const response of [new Response('untrusted-error', { status: 429 }), new Response('{invalid-json')]) {
      let calls = 0
      const generate = createTraceExplanationBatchGenerator(dependencies({ createFetch: () => ({
        fetch: async () => { calls += 1; return response }, close: async () => undefined,
      }) }))
      expect(await generate(input())).toBeNull()
      expect(calls).toBe(1)
    }
  })

  test('Given 超过256KiB的UTF8响应 When 读取 Then 不因字符数较小绕过字节限制', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: '中'.repeat(100000) } }] })
    expect(body.length).toBeLessThan(256 * 1024)
    const generate = createTraceExplanationBatchGenerator(dependencies({ createFetch: () => ({
      fetch: async () => new Response(body), close: async () => undefined,
    }) }))
    expect(await generate(input())).toBeNull()
  })

  test('Given content-length已超预算 When 读取 Then 取消响应正文', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const generate = createTraceExplanationBatchGenerator(dependencies({ createFetch: () => ({
      fetch: async () => new Response(stream, { headers: { 'content-length': String(256 * 1024 + 1) } }),
      close: async () => undefined,
    }) }))
    expect(await generate(input())).toBeNull()
    expect(cancelled).toBe(true)
  })

  test('Given 主Agent恢复运行而取消在途请求 When 外部abort Then 及时结束且不重试', async () => {
    const controller = new AbortController()
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    let calls = 0
    let closes = 0
    let signal: AbortSignal | null | undefined
    const generate = createTraceExplanationBatchGenerator(dependencies({ createFetch: () => ({
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        calls += 1
        signal = init?.signal
        signal?.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true })
        ready()
      }), close: async () => { closes += 1 },
    }) }))
    const task = generate(input(controller.signal))
    await started
    controller.abort()
    expect(await task).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(calls).toBe(1)
    expect(closes).toBe(1)
  })

  test('Given 响应头返回后正文挂起 When 外部abort Then 取消reader并释放资源', async () => {
    const controller = new AbortController()
    let ready!: () => void
    const reading = new Promise<void>((resolve) => { ready = resolve })
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ pull() { ready() }, cancel() { cancelled = true } }, { highWaterMark: 0 })
    const generate = createTraceExplanationBatchGenerator(dependencies({ createFetch: () => ({
      fetch: async () => new Response(stream), close: async () => undefined,
    }) }))
    const task = generate(input(controller.signal))
    await reading
    controller.abort()
    expect(await task).toBeNull()
    expect(cancelled).toBe(true)
  })

  test('Given 已取消或不支持的订阅渠道 When 生成 Then 不碰API Key或网络', async () => {
    let touched = false
    const controller = new AbortController()
    controller.abort()
    for (const provider of ['xai', 'github-copilot'] as const) {
      const generate = createTraceExplanationBatchGenerator(dependencies({
        getChannel: () => channel(provider),
        resolveApiKey: async () => { touched = true; return 'unused' },
        getProxyUrl: async () => { touched = true; return undefined },
      }))
      expect(await generate(input())).toBeNull()
      expect(await generate(input(controller.signal))).toBeNull()
    }
    expect(touched).toBe(false)
  })

  test('Given Codex OAuth渠道 When 生成 Then 走独立OAuth边界并传入768tokens和12秒限制', async () => {
    let captured: Parameters<NonNullable<TraceExplanationGeneratorDependencies['generateCodex']>>[0] | undefined
    const generate = createTraceExplanationBatchGenerator(dependencies({
      getChannel: () => channel('openai-codex'),
      resolveApiKey: async () => { throw new Error('OAuth不应走API Key') },
      generateCodex: async (options) => { captured = options; return '[{"id":"one"}]' },
    }))
    expect(await generate(input())).toBe('[{"id":"one"}]')
    expect(captured?.maxOutputTokens).toBe(768)
    expect(captured?.timeoutMs).toBe(12000)
    expect(captured?.signal).toBeInstanceOf(AbortSignal)
  })
})
