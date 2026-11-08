import { randomUUID } from 'node:crypto'
import type { AgentTraceEvent } from '@snap/shared'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { sanitizeAgentTraceEvent } from './agent-trace-sanitize'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** 在 Pi 原生边界采集；不依赖聊天时间，也不改变任何 Pi 消息或控制流。 */
export class AgentTraceCollector {
  readonly runId: string
  private artifactFile?: string
  private roundIndex = 0
  private requestIndex = 0
  private lastRequestId?: string
  private closed = false
  private readonly spans = new Map<string, AgentTraceEvent>()
  private readonly tools = new Map<string, unknown>()
  private readonly completedRequests = new Map<string, AgentTraceEvent>()
  private readonly requestByAssistant = new WeakMap<object, string>()
  private retryId?: string
  private compactionId?: string

  constructor(
    readonly sessionId: string,
    private readonly sink: (event: AgentTraceEvent) => void,
    private readonly now: () => number = Date.now,
    runId: string = randomUUID(),
  ) { this.runId = runId }

  bindArtifact(file: string | undefined): void { this.artifactFile = file }

  private emit(event: AgentTraceEvent): void {
    if (this.closed) return
    try {
      this.sink(sanitizeAgentTraceEvent({
        ...event,
        metadata: { ...event.metadata, artifactFile: this.artifactFile },
      }))
    } catch { /* 轨迹存储/订阅异常不能打断模型或工具执行。 */ }
  }

  private base(kind: AgentTraceEvent['kind'], name: string, id: string = randomUUID()): AgentTraceEvent {
    return { id, sessionId: this.sessionId, runId: this.runId, kind, name, status: 'running',
      source: 'live', roundIndex: Math.max(1, this.roundIndex), startedAt: this.now() }
  }

  private start(event: AgentTraceEvent): string {
    this.spans.set(event.id, event)
    this.emit(event)
    return event.id
  }

  private end(id: string, status: AgentTraceEvent['status'], output?: unknown, metadata?: Record<string, unknown>, messageUuid?: string): void {
    const span = this.spans.get(id)
    if (!span) return
    const endedAt = this.now()
    this.spans.delete(id)
    const completed = { ...span, status, endedAt, durationMs: Math.max(0, endedAt - (span.startedAt ?? endedAt)),
      output, messageUuid, metadata: { ...span.metadata, ...metadata } }
    if (span.kind === 'model') this.completedRequests.set(id, completed)
    this.emit(completed)
  }

  /** 此处的 context 已经过 Pi transformContext/convertToLlm，尚未经 provider HTTP 编码。 */
  startRequest(modelValue: unknown, contextValue: unknown, optionsValue?: unknown): string {
    if (this.retryId) {
      this.end(this.retryId, 'completed', { state: 'attempt-started', note: '等待结束；是否恢复见该次模型调用结果' })
      this.retryId = undefined
    }
    const model = asRecord(modelValue)
    const context = asRecord(contextValue)
    const options = asRecord(optionsValue)
    const parameters: Record<string, unknown> = {}
    for (const key of ['maxTokens', 'temperature', 'reasoning', 'thinkingLevel', 'reasoningEffort', 'transport', 'serviceTier']) {
      if (options[key] !== undefined) parameters[key] = options[key]
    }
    const messages = Array.isArray(context.messages) ? context.messages : []
    this.requestIndex += 1
    const requestId = randomUUID()
    this.lastRequestId = requestId
    const system = messages.filter((message) => asRecord(message).role === 'system')
    const loadout = new Map<string, unknown>()
    for (const message of system) {
      const row = asRecord(message)
      for (const tool of Array.isArray(row.toolsAdded) ? row.toolsAdded : []) {
        const descriptor = asRecord(tool)
        if (typeof descriptor.name === 'string') loadout.set(descriptor.name, tool)
      }
      for (const tool of Array.isArray(row.toolsRemoved) ? row.toolsRemoved : []) {
        const name = asRecord(tool).name
        if (typeof name === 'string') loadout.delete(name)
      }
    }
    this.tools.clear()
    for (const [name, value] of loadout) this.tools.set(name, value)
    const common = { requestId, metadata: { model: model.id, provider: model.provider, api: model.api,
      requestIndex: this.requestIndex, parameters, contextLayer: 'pi-provider-context' } }
    if (system.length) this.emit({ ...this.base('system', '系统提示词'), ...common,
      status: 'completed', input: system, schema: [...loadout.values()] })
    this.emit({ ...this.base('context', '模型请求上下文'), ...common, status: 'completed', input: { messages } })
    return this.start({ ...this.base('model', String(model.id ?? '模型调用'), requestId), ...common,
      schema: [...loadout.values()] })
  }

  finishRequest(requestId: string, messageValue: unknown, messageUuid?: string): void {
    if (messageValue && typeof messageValue === 'object') this.requestByAssistant.set(messageValue, requestId)
    const message = asRecord(messageValue)
    const status = message.stopReason === 'aborted' ? 'interrupted'
      : message.stopReason === 'error' ? 'error' : 'completed'
    this.end(requestId, status, message.content, {
      usage: message.usage, stopReason: message.stopReason, error: message.errorMessage,
      model: message.model, provider: message.provider, responseId: message.responseId,
    }, messageUuid)
  }

  /** Pi message_end 在落盘之前；prompt 收束后按同一消息对象精确关联所有 entry，含隐藏的失败尝试。 */
  bindNativeEntries(entries: readonly unknown[]): void {
    for (const value of entries) {
      const entry = asRecord(value)
      if (entry.type !== 'message' || typeof entry.id !== 'string' || !entry.message || typeof entry.message !== 'object') continue
      const requestId = this.requestByAssistant.get(entry.message)
      const completed = requestId ? this.completedRequests.get(requestId) : undefined
      if (!requestId || !completed) continue
      const updated = { ...completed, metadata: { ...completed.metadata, nativeEntryId: entry.id } }
      this.completedRequests.set(requestId, updated)
      this.emit(updated)
    }
  }

  failRequest(requestId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.end(requestId, /abort|cancel/i.test(message) ? 'interrupted' : 'error', { error: message })
  }

  /** 直接接受原生事件，保留聊天 UI 有意隐藏的失败与前五次重试。 */
  onPiEvent(value: unknown, messageUuid?: string): void {
    const event = asRecord(value)
    const message = asRecord(event.message)
    switch (event.type) {
      case 'message_start':
        if (message.role === 'user') {
          this.roundIndex += 1
          this.emit({ ...this.base('input', '用户输入'), status: 'completed', input: message.content,
            messageUuid, metadata: { contextLayer: 'pi-transcript', nativeTimestamp: message.timestamp } })
        }
        break
      case 'message_end':
        // stream.result() 先收束模型 span；message_end 只追加可用的 UI 消息关联。
        if (message.role === 'assistant') {
          const requestId = this.requestByAssistant.get(message) ?? this.lastRequestId
          if (requestId && this.spans.has(requestId)) this.finishRequest(requestId, message, messageUuid)
          else if (requestId && messageUuid) {
            const completed = this.completedRequests.get(requestId)
            if (completed) {
              const updated = { ...completed, messageUuid }
              this.completedRequests.set(requestId, updated)
              this.emit(updated)
            }
          }
        }
        break
      case 'tool_execution_start': {
        const toolCallId = String(event.toolCallId)
        const name = String(event.toolName ?? '工具')
        this.start({ ...this.base('tool', name, `${this.runId}:tool:${toolCallId}`), requestId: this.lastRequestId,
          parentId: this.lastRequestId, input: event.args, schema: this.tools.get(name), metadata: { toolCallId } })
        break
      }
      case 'tool_execution_end':
        this.end(`${this.runId}:tool:${String(event.toolCallId)}`, event.isError ? 'error' : 'completed', event.result)
        break
      case 'auto_retry_start':
        if (this.retryId) this.end(this.retryId, 'completed', { state: 'rescheduled', note: '收到下一次重试安排' })
        this.retryId = randomUUID()
        this.start({ ...this.base('retry', '重试等待', this.retryId),
          requestId: this.lastRequestId, input: { attempt: event.attempt, maxAttempts: event.maxAttempts,
            delayMs: event.delayMs, error: event.errorMessage } })
        break
      case 'auto_retry_end':
        {
          const status = event.success ? 'completed' : /cancel|abort/i.test(String(event.finalError)) ? 'interrupted' : 'error'
          if (this.retryId) this.end(this.retryId, status, { attempt: event.attempt, error: event.finalError })
          else this.emit({ ...this.base('retry', event.success ? '重试已恢复' : status === 'interrupted' ? '重试已取消' : '重试失败'),
            status, output: { attempt: event.attempt, error: event.finalError } })
          this.retryId = undefined
        }
        break
      case 'compaction_start':
        this.compactionId = randomUUID()
        this.start({ ...this.base('compaction', '压缩上下文', this.compactionId), input: { reason: event.reason } })
        break
      case 'compaction_end':
        if (this.compactionId) this.end(this.compactionId, event.aborted ? 'interrupted' : event.result ? 'completed' : 'error',
          event.result ?? { error: event.errorMessage }, { reason: event.reason })
        break
    }
  }

  finish(interrupted: boolean, error?: unknown): void {
    if (this.closed) return
    for (const span of this.spans.values()) this.emit({ ...span, status: interrupted ? 'interrupted' : 'error',
      output: { error: error instanceof Error ? error.message : error == null ? '运行结束，未收到该步骤的终态' : String(error) },
      metadata: { ...span.metadata, historyIncomplete: true, timing: 'end-not-recorded' } })
    this.spans.clear()
    if (error != null) this.emit({ ...this.base('error', '运行错误'), status: interrupted ? 'interrupted' : 'error',
      output: { error: error instanceof Error ? error.message : String(error) } })
    this.closed = true
  }
}

/** 保留原始 stream 与事件顺序，仅旁听其 result；不消费第二份 iterator。 */
export function observeAgentTraceStream(next: StreamFn, trace: AgentTraceCollector): StreamFn {
  return async (model, context, options) => {
    let requestId: string | undefined
    try { requestId = trace.startRequest(model, context, options) } catch { /* 采集失败时继续原请求。 */ }
    try {
      const stream = await next(model, context, options)
      if (requestId) {
        const id = requestId
        void stream.result().then((message) => trace.finishRequest(id, message), (error: unknown) => trace.failRequest(id, error))
      }
      return stream
    } catch (error) {
      if (requestId) trace.failRequest(requestId, error)
      throw error
    }
  }
}
