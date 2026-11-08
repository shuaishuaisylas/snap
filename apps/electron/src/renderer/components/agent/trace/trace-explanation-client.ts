import type { AgentTraceEvent } from '@snap/shared'
import type { TraceViewState } from './trace-state'
import { mergeTraceEvents } from './trace-view'

interface ExplanationClientOptions {
  request: (sessionId: string, enabled: boolean, eventIds?: string[]) => Promise<AgentTraceEvent[]>
  getState: (sessionId: string) => TraceViewState
  setState: (sessionId: string, update: (previous: TraceViewState) => TraceViewState) => void
}

/** 用户开关的最新意图优先于迟到 IPC；仅维护本面板的请求，不启动模型或自动重试。 */
export class TraceExplanationClient {
  private generation = 0
  private readonly requested = new Set<string>()
  constructor(private readonly options: ExplanationClientOptions) {}

  invalidate(): void { this.generation += 1; this.requested.clear() }

  async setEnabled(sessionId: string, enabled: boolean, eventIds: string[] = []): Promise<void> {
    const generation = ++this.generation
    const before = new Map(this.options.getState(sessionId).events.map((event) => [event.id, event]))
    if (!enabled) this.requested.clear()
    else for (const id of eventIds) this.requested.add(`${sessionId}:${id}`)
    // 关闭即刻隐藏；即使取消失败，也不能继续展示用户已关闭的说明。
    this.options.setState(sessionId, (previous) => ({ ...previous, explanationsEnabled: enabled, explanationsSyncing: true, explanationsError: null }))
    try {
      const events = await this.options.request(sessionId, enabled, eventIds)
      if (generation !== this.generation) return
      this.options.setState(sessionId, (previous) => {
        const current = new Map(previous.events.map((event) => [event.id, event]))
        // IPC 快照返回前若已有新的实时证据，不用旧快照覆盖它。
        const accepted = events.filter((event) => !current.has(event.id) || current.get(event.id) === before.get(event.id))
        return { ...previous, events: mergeTraceEvents(previous.events, accepted, sessionId), explanationsSyncing: false, explanationsError: null }
      })
    } catch {
      if (generation !== this.generation) return
      this.options.setState(sessionId, (previous) => ({ ...previous, explanationsSyncing: false,
        explanationsError: enabled ? 'AI说明开启失败，请关闭后重新开启。' : '未能确认后台已停止，请重试关闭AI说明。' }))
    }
  }

  async requestMissing(sessionId: string, eventId: string): Promise<void> {
    if (!this.options.getState(sessionId).explanationsEnabled || this.requested.has(`${sessionId}:${eventId}`)) return
    await this.setEnabled(sessionId, true, [eventId])
  }
}
