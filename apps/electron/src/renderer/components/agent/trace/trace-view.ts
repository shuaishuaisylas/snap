import type { AgentTraceEvent } from '@snap/shared'

export type TraceTimeMode = 'order' | 'duration'
export type TraceDetailTab = 'overview' | 'input' | 'output' | 'context' | 'schema' | 'timing'
export type TraceLane = 'input' | 'model' | 'tool'

export interface TraceTimelineItem {
  event: AgentTraceEvent
  lane: TraceLane
  left: number
  width: number
  point: boolean
}

export interface TraceTimeline {
  items: TraceTimelineItem[]
  missingCount: number
  start?: number
  end?: number
}

export interface TraceRound {
  id: string
  label: string
  events: AgentTraceEvent[]
}

export type TraceListRow =
  | { id: string; type: 'round'; round: TraceRound }
  | { id: string; type: 'event'; event: AgentTraceEvent }

/** 保留采集顺序；同一事件的流式更新替换原位置，不重复追加。 */
export function mergeTraceEvents(
  base: readonly AgentTraceEvent[],
  updates: readonly AgentTraceEvent[],
  sessionId: string,
): AgentTraceEvent[] {
  const byId = new Map<string, AgentTraceEvent>()
  for (const event of [...base, ...updates]) {
    if (event.sessionId === sessionId) byId.set(event.id, event)
  }
  // 打开面板时原生消息可能已写入，但精确请求还没有绑定 nativeEntryId。
  // 后续绑定更新到达后移除对应的历史模型副本；精确失败/成功请求始终各自保留。
  const preciseModelEntries = new Set<string>()
  for (const event of byId.values()) {
    const nativeEntryId = event.metadata?.nativeEntryId
    if (event.kind === 'model' && event.runId && typeof nativeEntryId === 'string' && nativeEntryId) {
      preciseModelEntries.add(nativeEntryId)
    }
  }
  return [...byId.values()].filter((event) => {
    if (event.kind !== 'model' || event.runId || event.source !== 'history') return true
    const nativeEntryId = event.metadata?.nativeEntryId
    return typeof nativeEntryId !== 'string' || !preciseModelEntries.has(nativeEntryId)
  })
}

export function traceValueText(value: unknown): string {
  if (value === undefined) return '未记录'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const searchCache = new WeakMap<AgentTraceEvent, string>()

export function isTraceException(event: AgentTraceEvent): boolean {
  return event.kind === 'error' || event.status === 'error' || event.status === 'interrupted'
}

export function filterTraceEvents(
  events: readonly AgentTraceEvent[],
  query: string,
  onlyExceptions: boolean,
): AgentTraceEvent[] {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase()
  return events.filter((event) => {
    if (onlyExceptions && !isTraceException(event)) return false
    if (!normalized) return true
    let text = searchCache.get(event)
    if (text === undefined) {
      text = [event.name, event.kind, event.status, traceValueText(event.input),
        traceValueText(event.output), traceValueText(event.schema), traceValueText(event.metadata)]
        .join('\n').normalize('NFKC').toLocaleLowerCase()
      searchCache.set(event, text)
    }
    return text.includes(normalized)
  })
}

export function traceLane(event: AgentTraceEvent): TraceLane {
  if (event.kind === 'tool') return 'tool'
  if (event.kind === 'system' || event.kind === 'context' || event.kind === 'input') return 'input'
  return 'model'
}

function finiteTime(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function traceDuration(event: AgentTraceEvent): number | undefined {
  if (finiteTime(event.durationMs)) return event.durationMs
  if (finiteTime(event.startedAt) && finiteTime(event.endedAt) && event.endedAt >= event.startedAt) {
    return event.endedAt - event.startedAt
  }
  return undefined
}

export function traceDurationLabel(duration: number | undefined): string {
  if (duration === undefined) return '未记录'
  if (duration < 1000) return `${Math.round(duration)} 毫秒`
  if (duration < 60000) return `${(duration / 1000).toFixed(duration < 10000 ? 2 : 1)} 秒`
  return `${Math.floor(duration / 60000)} 分 ${Math.round(duration % 60000 / 1000)} 秒`
}

/** 三条轨道共用同一坐标系，缺时间的事件不强行填入耗时轴。 */
export function buildTraceTimeline(events: readonly AgentTraceEvent[], mode: TraceTimeMode): TraceTimeline {
  if (mode === 'order') {
    const count = Math.max(events.length, 1)
    return {
      items: events.map((event, index) => ({ event, lane: traceLane(event), left: index / count * 100, width: 100 / count, point: false })),
      missingCount: 0,
    }
  }
  const timed = events.flatMap((event) => {
    if (!finiteTime(event.startedAt)) return []
    const duration = traceDuration(event)
    const end = finiteTime(event.endedAt) && event.endedAt >= event.startedAt
      ? event.endedAt
      : duration !== undefined ? event.startedAt + duration : event.startedAt
    return [{ event, start: event.startedAt, end, point: duration === undefined && end === event.startedAt }]
  })
  if (!timed.length) return { items: [], missingCount: events.length }
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const item of timed) { start = Math.min(start, item.start); end = Math.max(end, item.end) }
  const span = end - start
  return {
    start, end, missingCount: events.length - timed.length,
    items: timed.map((item) => ({
      event: item.event, lane: traceLane(item.event),
      left: span === 0 ? 0 : (item.start - start) / span * 100,
      width: span === 0 ? 0 : (item.end - item.start) / span * 100,
      point: item.point || item.end === item.start,
    })),
  }
}

export function traceRoundId(event: AgentTraceEvent): string {
  return `${event.runId ?? 'history'}:${event.roundIndex ?? 'unknown'}`
}

export function groupTraceRounds(events: readonly AgentTraceEvent[], allEvents: readonly AgentTraceEvent[] = events): TraceRound[] {
  const groups = new Map<string, TraceRound>()
  const runs = new Map<string, number>()
  for (const event of allEvents) if (event.runId && !runs.has(event.runId)) runs.set(event.runId, runs.size + 1)
  for (const event of events) {
    const id = traceRoundId(event)
    let group = groups.get(id)
    if (!group) {
      const run = event.runId ? `执行 ${runs.get(event.runId)} · ` : '历史 · '
      group = { id, label: run + (event.roundIndex === undefined ? '未记录轮次' : `第 ${event.roundIndex} 轮`), events: [] }
      groups.set(id, group)
    }
    group.events.push(event)
  }
  return [...groups.values()]
}

/** 只关联同一次请求的真实上下文，不以当前配置补写历史。 */
export function traceModelContexts(event: AgentTraceEvent, events: readonly AgentTraceEvent[]): AgentTraceEvent[] {
  if (event.kind === 'context' || event.kind === 'system') return [event]
  if (!event.requestId) return []
  return events.filter((candidate) => candidate.kind === 'context'
    && candidate.sessionId === event.sessionId
    && candidate.requestId === event.requestId
    && candidate.runId === event.runId)
}

export function buildTraceRows(rounds: readonly TraceRound[], collapsed: readonly string[]): TraceListRow[] {
  const hidden = new Set(collapsed)
  return rounds.flatMap((round): TraceListRow[] => [
    { id: `round:${round.id}`, type: 'round', round },
    ...(hidden.has(round.id) ? [] : round.events.map((event): TraceListRow => ({ id: `event:${event.id}`, type: 'event', event }))),
  ])
}

export function traceStatusLabel(event: AgentTraceEvent): string {
  switch (event.status) {
    case 'running': return '进行中'
    case 'error': return '失败'
    case 'interrupted': return '已中断'
    case 'unknown': return '状态未知'
    case 'completed': return event.kind === 'tool' ? '已返回' : event.kind === 'model' ? '已结束' : '已记录'
  }
}

export const TRACE_KIND_LABELS: Record<AgentTraceEvent['kind'], string> = {
  system: '系统', context: '上下文', input: '用户输入', model: '模型', tool: '工具', retry: '重试', compaction: '压缩', error: '错误',
}

export function tracePreview(event: AgentTraceEvent): string {
  const candidate = event.output ?? event.input
  if (typeof candidate === 'string') return candidate.replace(/\s+/g, ' ').slice(0, 180)
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>
    for (const key of ['summary', 'message', 'text', 'command', 'file_path', 'path', 'error']) {
      if (typeof record[key] === 'string') return record[key].replace(/\s+/g, ' ').slice(0, 180)
    }
    return Array.isArray(candidate) ? `${candidate.length} 项内容` : `${Object.keys(candidate).length} 个字段 · 点击查看详情`
  }
  return '点击查看记录详情'
}

export function moveTraceSelection(events: readonly AgentTraceEvent[], currentId: string | null, key: string): string | null {
  if (!events.length) return null
  const current = events.findIndex((event) => event.id === currentId)
  if (key === 'Home') return events[0]!.id
  if (key === 'End') return events.at(-1)!.id
  if (key === 'ArrowDown') return events[Math.min(current + 1, events.length - 1)]!.id
  if (key === 'ArrowUp') return events[Math.max(0, current - 1)]!.id
  return currentId
}

/** 大对象每批只挂载少量字段，展开操作才能继续递归，复制仍使用完整原值。 */
export function traceValueEntries(value: object, limit: number): Array<[string, unknown]> {
  const keys = Object.keys(value)
  return keys.slice(0, limit).map((key) => [key, (value as Record<string, unknown>)[key]])
}

/** 展示层旧回复不能用于推算实际 provider 请求次数。 */
export function traceRecordCounts(events: readonly AgentTraceEvent[]): {
  modelCalls: number; toolCalls: number; historyReplies: number; historyIncomplete: boolean
} {
  const counts = { modelCalls: 0, toolCalls: 0, historyReplies: 0, historyIncomplete: false }
  for (const event of events) {
    if (event.kind === 'model') {
      if (event.metadata?.contextLayer === 'display-message') counts.historyReplies += 1
      else counts.modelCalls += 1
    }
    if (event.kind === 'tool') counts.toolCalls += 1
    if (event.metadata?.historyIncomplete === true) counts.historyIncomplete = true
  }
  return counts
}
