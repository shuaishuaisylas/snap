import type { Channel, ProviderType } from '@snap/shared'
import type { ProviderAdapter, ProviderRequest } from '@snap/core'

const EXPLANATION_MAX_TOKENS = 768
const EXPLANATION_TIMEOUT_MS = 12_000
const EXPLANATION_RESPONSE_BYTES = 256 * 1024

export interface TraceExplanationBatchInput {
  channelId: string
  modelId: string
  prompt: string
  signal: AbortSignal
}

interface TraceExplanationCodexInput extends TraceExplanationBatchInput {
  proxyUrl?: string
  maxOutputTokens: number
  timeoutMs: number
}

export interface TraceExplanationGeneratorDependencies {
  getChannel: (channelId: string) => Channel | undefined
  resolveApiKey: (channelId: string) => Promise<string>
  getAdapter: (provider: ProviderType) => Pick<ProviderAdapter, 'buildTitleRequest'>
  getProxyUrl: () => Promise<string | undefined>
  createFetch: (proxyUrl?: string) => {
    fetch: (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>
    close: () => Promise<void>
  }
  generateCodex?: (input: TraceExplanationCodexInput) => Promise<string | null>
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/** 只复用供应商的短文本请求结构，不复用标题提示、清洗、日志或重试。 */
export function buildTraceExplanationRequest(request: ProviderRequest): ProviderRequest {
  const body = record(JSON.parse(request.body))
  if ('max_output_tokens' in body) body.max_output_tokens = EXPLANATION_MAX_TOKENS
  else if ('generationConfig' in body) {
    body.generationConfig = { ...record(body.generationConfig), maxOutputTokens: EXPLANATION_MAX_TOKENS }
  } else body.max_tokens = EXPLANATION_MAX_TOKENS
  delete body.tools
  delete body.tool_choice
  delete body.parallel_tool_calls
  delete body.previous_response_id
  delete body.conversation
  return { ...request, body: JSON.stringify(body) }
}

function visibleBlocks(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    const block = record(item)
    return (block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string'
      ? block.text : ''
  }).join('')
}

/** 从已解析响应中读取可见正文；不从 reasoning/thinking 或工具参数兜底。 */
export function parseVisibleTraceExplanationText(value: unknown): string | null {
  const data = record(value)
  let text = ''
  if (typeof data.output_text === 'string') text = data.output_text
  else if (Array.isArray(data.choices)) text = visibleBlocks(record(record(data.choices[0]).message).content)
  else if (Array.isArray(data.output)) {
    text = data.output.map((item) => {
      const message = record(item)
      return message.type === 'message' ? visibleBlocks(message.content) : ''
    }).join('')
  } else if (Array.isArray(data.content)) text = visibleBlocks(data.content)
  else if (Array.isArray(data.candidates)) {
    const parts = record(record(data.candidates[0]).content).parts
    if (Array.isArray(parts)) text = parts.map((item) => {
      const part = record(item)
      return part.thought !== true && typeof part.text === 'string' ? part.text : ''
    }).join('')
  }
  return text.trim() || null
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason ?? new Error('解释已取消'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('解释已取消'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted || Number(response.headers.get('content-length')) > EXPLANATION_RESPONSE_BYTES) return null
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ''
    while (true) {
      const chunk = await waitWithSignal(reader.read(), signal)
      if (signal.aborted) return null
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > EXPLANATION_RESPONSE_BYTES) return null
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text.trim() ? JSON.parse(text) as unknown : null
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** 注入依赖供离线验证，不 mock 全局 Provider、Electron 或用户渠道配置。 */
export function createTraceExplanationBatchGenerator(deps: TraceExplanationGeneratorDependencies): (input: TraceExplanationBatchInput) => Promise<string | null> {
  return async (input) => {
    if (input.signal.aborted || !input.prompt.trim() || !input.modelId.trim()) return null
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(EXPLANATION_TIMEOUT_MS)])
    let transport: ReturnType<TraceExplanationGeneratorDependencies['createFetch']> | undefined
    try {
      const channel = deps.getChannel(input.channelId)
      if (!channel?.enabled || channel.provider === 'xai' || channel.provider === 'github-copilot') return null
      if (!channel.models.some((model) => model.id === input.modelId && model.enabled)) return null
      const proxyUrl = await waitWithSignal(deps.getProxyUrl(), signal)
      if (signal.aborted) return null
      if (channel.provider === 'openai-codex') {
        if (!deps.generateCodex) return null
        const text = await waitWithSignal(deps.generateCodex({ ...input, signal, proxyUrl,
          maxOutputTokens: EXPLANATION_MAX_TOKENS, timeoutMs: EXPLANATION_TIMEOUT_MS }), signal)
        return !signal.aborted && text && new TextEncoder().encode(text).byteLength <= EXPLANATION_RESPONSE_BYTES
          ? text.trim() || null : null
      }
      const apiKey = await waitWithSignal(deps.resolveApiKey(channel.id), signal)
      if (signal.aborted) return null
      const adapter = deps.getAdapter(channel.provider)
      const request = buildTraceExplanationRequest(adapter.buildTitleRequest({
        baseUrl: channel.baseUrl, apiKey, modelId: input.modelId, prompt: input.prompt,
      }))
      transport = deps.createFetch(proxyUrl)
      // 单次 fetch，不调用任何重试或标题生成包装器；外部取消贯通请求与响应读取。
      const response = await waitWithSignal(transport.fetch(request.url, {
        method: 'POST', headers: request.headers, body: request.body, signal,
      }), signal)
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null }
      return signal.aborted ? null : parseVisibleTraceExplanationText(await readBoundedResponse(response, signal))
    } catch {
      // 辅助解释失败保留本地规则，不影响 Agent，不打印 prompt、密钥或响应正文。
      return null
    } finally {
      await transport?.close().catch(() => undefined)
    }
  }
}

async function loadDefaultGenerator(): Promise<(input: TraceExplanationBatchInput) => Promise<string | null>> {
  const [channels, core, proxy, settings, codex] = await Promise.all([
    import('./channel-manager'), import('@snap/core'), import('./proxy-fetch'),
    import('./proxy-settings-service'), import('./adapters/pi-codex-title-generator'),
  ])
  return createTraceExplanationBatchGenerator({
    getChannel: channels.getChannelById,
    resolveApiKey: channels.resolveChannelRuntimeApiKey,
    getAdapter: core.getAdapter,
    getProxyUrl: settings.getEffectiveProxyUrl,
    createFetch: proxy.createManagedProxyFetch,
    generateCodex: async (input) => {
      const credentials = await channels.resolveCodexOAuthCredentials(input.channelId)
      if (input.signal.aborted) return null
      return codex.generateCodexTitle({ modelId: input.modelId, prompt: input.prompt,
        credentials, signal: input.signal, proxyUrl: input.proxyUrl, maxOutputTokens: input.maxOutputTokens,
        timeoutMs: input.timeoutMs,
        onCredentialsRefreshed: (refreshed) => channels.persistCodexOAuthCredentials(input.channelId, refreshed) })
    },
  })
}

let defaultGenerator: ReturnType<typeof loadDefaultGenerator> | undefined

export async function generateTraceExplanationBatch(input: TraceExplanationBatchInput): Promise<string | null> {
  if (input.signal.aborted) return null
  try {
    defaultGenerator ??= loadDefaultGenerator()
    return await (await defaultGenerator)(input)
  } catch { defaultGenerator = undefined; return null }
}
