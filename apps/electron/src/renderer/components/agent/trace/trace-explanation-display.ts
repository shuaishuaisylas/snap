import { getTraceExplanation } from '@snap/shared'
import type { AgentTraceEvent } from '@snap/shared'

export interface TraceExplanationDisplay {
  status: 'hidden' | 'pending' | 'ready' | 'unavailable'
  text: string
}

/** 不接受旧规则或旧版本缓存；关闭时连已生成的说明也不展示。 */
export function traceExplanationDisplay(event: AgentTraceEvent, enabled: boolean): TraceExplanationDisplay {
  if (!enabled) return { status: 'hidden', text: '' }
  const explanation = getTraceExplanation(event)
  if (explanation.source === 'model' && explanation.version >= 2) {
    if (explanation.status === 'ready' && explanation.text.trim()) return { status: 'ready', text: explanation.text.trim() }
    if (explanation.status === 'unavailable') return { status: 'unavailable', text: '' }
  }
  return { status: 'pending', text: '' }
}

/** 已选旧步骤优先，其余只请求当前筛选内最近的有限记录。 */
export function traceExplanationRequestIds(events: readonly AgentTraceEvent[], selectedId: string | null, limit = 120): string[] {
  const capped = Math.max(0, Math.min(120, Math.floor(limit)))
  if (!capped) return []
  const ids = new Set<string>()
  if (selectedId && events.some((event) => event.id === selectedId)) ids.add(selectedId)
  for (let index = events.length - 1; index >= 0 && ids.size < capped; index--) ids.add(events[index]!.id)
  return [...ids]
}

export function traceExplanationPreview(event: AgentTraceEvent): string {
  const display = traceExplanationDisplay(event, true)
  return display.status === 'ready' ? display.text : display.status === 'unavailable' ? 'AI说明暂不可用，可关闭后重新开启' : '等待AI说明'
}
